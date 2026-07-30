const {
  addUserInCache,
  removeUserInCache,
  findAvailableManagers,
  updateUserStatus,
  getOnlineUsersWithInfo,
  getAllManagers,
  AGENT_STATUS
} = require("../utils/cacheService");

// BullMQ queue service (replaces in-memory queue)
const {
  addCustomerToQueue,
  removeCustomerFromQueue,
  updateQueueEntrySocketId,
  getQueuePosition,
  getQueuedCustomers,
  getQueueStats,
  PRIORITY
} = require("./callQueueService");
const crypto = require("crypto");
const callLogService = require("./callLogService");
const customerService = require("./customerService");
const cbsService = require("./cbsService");
const { Recording } = require("../models");
const faceVerificationService = require("./faceVerificationService");
const { updateSessionSocketId } = require("../utils/sessionManager");
const OTP = require("./otpService");
const { generateFormPDF } = require("./pdfFormService");
const {
  publishCallSet,
  publishCallDelete,
  fetchCallFromRedis,
  publishSupervisorSet,
  publishSupervisorDelete,
} = require("../utils/callStateSync");

const OPENVIDU_DOMAIN = process.env.OPENVIDU_DOMAIN;
const CALL_TIMEOUT = 20000; // 20 seconds - banking industry standard

/**
 * Normalizes phone numbers to a consistent format (removes non-digits, strips country code prefix if present)
 */
const normalizePhone = (phone) => {
  if (!phone) return null;
  // Remove all non-numeric characters
  let cleaned = phone.toString().replace(/\D/g, '');
  // If it starts with 880 (Bangladesh country code), remove it
  if (cleaned.startsWith('880') && cleaned.length > 10) {
    cleaned = cleaned.substring(3);
  }
  // Ensure it starts with 0 for BD consistency (01XXXXX)
  if (cleaned.startsWith('1') && cleaned.length === 10) {
    cleaned = '0' + cleaned;
  }
  return cleaned;
};

const activeCustomerCalls = {};
const activeSupervisors = {}; // Track supervisors monitoring calls

// Grace-period timers: key → setTimeout id
// Customer keys:  normalizedPhone
// Manager keys:   `mgr:${email}:${normalizedPhone}`
const disconnectTimers = {};
const DISCONNECT_GRACE_MS = 30000; // 30 s to reconnect before call is force-ended

// Repeating "manager needs a supervisor" notification: key → { intervalId, timeoutId }
// Keyed by customerPhone since that's the active call's natural identity.
const assistanceTimers = {};
const ASSISTANCE_REPEAT_MS = 15000; // re-broadcast every 15s until claimed/cancelled
const ASSISTANCE_TIMEOUT_MS = 120000; // auto-expire after 2 minutes unanswered

const stopAssistanceTimers = (customerPhone) => {
  const timers = assistanceTimers[customerPhone];
  if (!timers) return;
  clearInterval(timers.intervalId);
  clearTimeout(timers.timeoutId);
  delete assistanceTimers[customerPhone];
};

// Replicates the current in-memory state of one activeCustomerCalls /
// activeSupervisors entry to every other pod (see callStateSync.js). Call
// after mutating fields directly on the local object — cheap enough to call
// after every logical mutation block, not just full create/delete.
const touchCall = (phone) => {
  const call = activeCustomerCalls[phone];
  if (call) publishCallSet(phone, call);
};

const removeCall = (phone) => {
  stopAssistanceTimers(phone);
  delete activeCustomerCalls[phone];
  publishCallDelete(phone);
};

const touchSupervisor = (socketId) => {
  const supervisor = activeSupervisors[socketId];
  if (supervisor) publishSupervisorSet(socketId, supervisor);
};

const removeSupervisor = (socketId) => {
  delete activeSupervisors[socketId];
  publishSupervisorDelete(socketId);
};

const handleSocketConnection = async (socket, io) => {
  // Normalize phone number if present for consistent tracking
  if (socket.user && socket.user.phone) {
    socket.user.phone = normalizePhone(socket.user.phone);
  }

  const { role, phone, name, email, isAdmin } = socket.user;
  const socketId = socket.id;

  // Direct CBS API log helper — bypasses EventEmitter, always reaches this socket
  const emitCbsLog = async (endpoint, argMap, fn) => {
    const ts = () => new Date().toISOString();
    socket.emit("debug:cbs-call", { endpoint, args: argMap, timestamp: ts() });
    try {
      const result = await fn();
      socket.emit("debug:cbs-response", { endpoint, result, timestamp: ts() });
      return result;
    } catch (err) {
      socket.emit("debug:cbs-error", { endpoint, error: err.message, timestamp: ts() });
      throw err;
    }
  };
  if (!socketId || !role) {
    console.error(`❌ Invalid socket connection: Missing required data`);
    socket.emit("call:error", { message: "Invalid connection data" });
    return socket.disconnect(true);
  }

  try {
    // Handle admin/supervisor connections differently
    if (isAdmin || role === 'admin' || role === 'supervisor') {
      console.log(`✅ Admin/Supervisor connected: ${socketId} | Role: ${role} | Email: ${email}`);
      // Store admin/supervisor in activeSupervisors for tracking
      activeSupervisors[socketId] = {
        email,
        role,
        connectedAt: Date.now()
      };
      touchSupervisor(socketId);
    } else {
      await addUserInCache(phone, role, socketId, name, email);
      console.log(
        `✅ User connected: ${socketId} | Role: ${role}` +
        (phone ? ` | Phone: ${phone}` : "") +
        (name ? ` | Name: ${name}` : "") +
        (email ? ` | Email: ${email}` : "")
      );

      // Update session with socket ID for managers (for force-logout feature)
      if (role === "manager" && socket.user.id) {
        updateSessionSocketId(socket.user.id, socketId);

      }

      // 🔄 SYNC ACTIVE CALL STATES: Refresh socket IDs for either role on reconnect
      if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        if (activeCustomerCalls[normalizedPhone]) {
          console.log(`♻️ Customer ${normalizedPhone} reconnected - updating call state socketId: ${socketId}`);
          activeCustomerCalls[normalizedPhone].customerSocketId = socketId;
          touchCall(normalizedPhone);

          // Cancel the grace-period timer if customer reconnects in time
          if (disconnectTimers[normalizedPhone]) {
            clearTimeout(disconnectTimers[normalizedPhone]);
            delete disconnectTimers[normalizedPhone];
            console.log(`✅ Customer ${normalizedPhone} reconnected within grace period — call continues`);
            const managerSocketId = activeCustomerCalls[normalizedPhone].managerSocketId;
            if (managerSocketId) {
              io.to(managerSocketId).emit("customer:reconnected", { message: "Customer reconnected" });
            }
          }
        }

        // Always broadcast the cancel, even if a local entry was found above —
        // a local entry can be a stale clone (from ensureLocalActiveCall being
        // triggered by an earlier CBS/HTTP request landing on this pod) while
        // the REAL grace timer runs on a different pod. Gating this behind
        // "nothing found locally" let that real timer survive an apparently
        // successful reconnect and force-end the call 15s later regardless.
        if (io) {
          const activeCall = await ensureLocalActiveCall(io, normalizedPhone);
          if (activeCall) {
            activeCall.customerSocketId = socketId;
            touchCall(normalizedPhone);
            try {
              const results = await io.serverSideEmitWithAck("cancel-disconnect-timer-local", normalizedPhone);
              if (results.some(Boolean)) {
                console.log(`✅ Customer ${normalizedPhone} reconnected cross-pod within grace period — call continues`);
                const managerSocketId = activeCall.managerSocketId;
                if (managerSocketId) {
                  io.to(managerSocketId).emit("customer:reconnected", { message: "Customer reconnected" });
                }
              }
            } catch (error) {
              console.error(`⚠️ Cross-pod customer-reconnect sync failed for ${normalizedPhone}:`, error.message);
            }
          }
        }

        // Customer may instead (or additionally) be waiting in the BullMQ
        // queue rather than in an active call — that job's stored socketId
        // goes stale on every backend restart since Socket.IO state is
        // in-memory but BullMQ jobs persist in Redis. Refresh it so a
        // manager's later "pick from queue" doesn't wrongly report the
        // customer as disconnected.
        updateQueueEntrySocketId(normalizedPhone, socketId).catch(err => {
          console.error(`❌ Failed to refresh queue socketId for ${normalizedPhone}:`, err.message);
        });
      } else if (role === "manager" && email) {
        // Find if this manager has any active calls and update their socketId
        let hasActiveCall = false;
        Object.keys(activeCustomerCalls).forEach(custPhone => {
          if (activeCustomerCalls[custPhone].currentManagerEmail === email) {
            console.log(`♻️ Manager ${email} reconnected - updating active call with ${custPhone} to socketId: ${socketId}`);
            activeCustomerCalls[custPhone].managerSocketId = socketId;
            touchCall(custPhone);
            // Restore customerPhone on the new socket so manager operations work
            socket.user.customerPhone = custPhone;
            hasActiveCall = true;

            // Cancel the grace-period timer if manager reconnects in time
            const timerKey = `mgr:${email}:${normalizePhone(custPhone)}`;
            if (disconnectTimers[timerKey]) {
              clearTimeout(disconnectTimers[timerKey]);
              delete disconnectTimers[timerKey];
              console.log(`✅ Manager ${email} reconnected within grace period — call continues`);
              const custSocketId = activeCustomerCalls[custPhone].customerSocketId;
              if (custSocketId) {
                io.to(custSocketId).emit("manager:reconnected", { message: "Manager reconnected" });
              }
            }

            // Manager-panel's own socket "disconnect" handler eagerly resets
            // its call UI to idle on any blip, before this grace-period logic
            // even runs — so a manager who reconnects in time still has no
            // route back into the call unless the client gets something
            // concrete to rehydrate from. Always emit this on reconnect
            // (not just when the grace timer was pending) since the manager's
            // own UI has no other way to know the call survived.
            socket.emit("manager:active-call-restored", {
              customerPhone: custPhone,
              callRoom: activeCustomerCalls[custPhone].callRoom,
              customerName: activeCustomerCalls[custPhone].customerName || null,
              referenceNumber: activeCustomerCalls[custPhone].referenceNumber || null,
              faceVerified: activeCustomerCalls[custPhone].faceVerified || false,
            });
          }
        });

        // Always broadcast, even if a local entry was found above — a local
        // entry can be a stale clone (from ensureLocalActiveCall being
        // triggered by an earlier CBS/HTTP request landing on this pod) while
        // the REAL grace timer runs on a different pod. Gating this behind
        // "nothing found locally" let that real timer survive an apparently
        // successful reconnect and force-end the call 15s later regardless.
        if (io) {
          try {
            const results = await io.serverSideEmitWithAck("manager-reconnect-local", { email, newSocketId: socketId });
            const custPhone = results.find(Boolean);
            if (custPhone) {
              console.log(`🔁 Manager ${email} reconnected on a different pod — resumed active call with ${custPhone} cross-pod`);
              socket.user.customerPhone = custPhone;
              hasActiveCall = true;
              const resumedCall = await ensureLocalActiveCall(io, normalizePhone(custPhone));
              if (resumedCall) {
                socket.emit("manager:active-call-restored", {
                  customerPhone: custPhone,
                  callRoom: resumedCall.callRoom,
                  customerName: resumedCall.customerName || null,
                  referenceNumber: resumedCall.referenceNumber || null,
                  faceVerified: resumedCall.faceVerified || false,
                });
              }
            }
          } catch (error) {
            console.error(`⚠️ Cross-pod manager-reconnect sync failed for ${email}:`, error.message);
          }
        }

        // If no active call, reset status to online (Redis may still have "busy" from a previous call)
        if (!hasActiveCall) {
          updateUserStatus(email, "manager", AGENT_STATUS.ONLINE);
          console.log(`🟢 Manager ${email} reconnected with no active call — status reset to online`);
          // The manager panel deliberately keeps its own call UI intact across
          // a raw disconnect (in case the call is still alive server-side) —
          // this tells it definitively that it is not, so it can clear
          // instead of showing a stale in-call screen forever.
          socket.emit("manager:no-active-call");
        }
      }
    }

    if (role === "customer") {
      socket.emit("manager:list", findAvailableManagers());
    } else if (role === "manager") {
      // Push the current queue snapshot on every (re)connect rather than
      // relying solely on the frontend requesting "queue:get" at the right
      // moment. A manager only ever learns about queue changes from live
      // "queue:updated" broadcasts, so anything already queued before this
      // socket connected — or before a reconnect after a network blip / pod
      // restart during a rolling deploy — was invisible until the next
      // mutation. This mirrors the push customers already get above.
      try {
        const [queue, stats] = await Promise.all([getQueuedCustomers(), getQueueStats()]);
        socket.emit("queue:list", { queue, stats });
      } catch (error) {
        console.error(`⚠️ Failed to push initial queue snapshot to manager ${email}:`, error.message);
      }
    }

    socket.on("call:initiate", async (data) => {
      if (role !== "customer") return;

      // Defense in depth: socketAuth already rejects unauthenticated customer
      // handshakes, but a call must never start without a verified OTP session.
      // This makes the invariant explicit at the entry point (pentest finding #1).
      if (!socket.user?.isAuthenticated) {
        console.warn(`🚫 call:initiate blocked for ${phone} — session not OTP-verified`);
        socket.emit("call:failed", {
          message: "Verification required before starting a call.",
        });
        return;
      }

      try {
        await handleCallInitiate(data);
      } catch (error) {
        // Without this, any unexpected throw here (e.g. clearActiveCustomerCall)
        // left the customer's socket with no ack at all — the frontend was
        // already showing the queue-waiting screen with nothing to ever clear it.
        console.error(`❌ call:initiate failed for ${phone}:`, error);
        socket.emit("call:failed", {
          message: "Unable to initiate call. Please try again."
        });
      }
    });

    const handleCallInitiate = async (data) => {
      const { verificationInfo } = data || {};
      console.log(`🔄 Customer ${phone} initiating call - checking customer registration (optional)`);
      console.log(`📋 Verification info:`, verificationInfo);

      // A page reload/reconnect while a manager already picked this call up
      // re-fires call:initiate on mount. The connection handler above already
      // re-attached this new socket to the existing activeCustomerCalls entry
      // (customerSocketId refresh, grace-timer cancel) — clearing it here
      // would destroy the in-progress call and bounce the manager back to the
      // queue screen. Only wipe stale entries with no manager assigned yet.
      const existingCall = activeCustomerCalls[phone];
      if (existingCall && existingCall.currentManagerEmail) {
        console.log(`♻️ Customer ${phone} re-initiated call while already in-progress with ${existingCall.currentManagerEmail} — resuming instead of clearing`);
        socket.emit("call:accepted", {
          managerId: existingCall.currentManagerEmail,
          managerName: existingCall.managerName || null,
          callRoom: existingCall.callRoom,
          referenceNumber: existingCall.referenceNumber || null,
          routingTime: 0,
        });
        return;
      }

      await clearActiveCustomerCall(phone, io);

      // Run all CBS lookups in parallel — non-blocking, proceed even if they fail
      let customerAccounts = [];
      let cbsLookup = null;
      let isInternal = false;
      const verificationPhoneOrEmail = verificationInfo?.phoneOrEmail || null;

      await Promise.allSettled([
        customerService.getAccountsListByPhone(phone).then(r => { customerAccounts = r || []; }),
        cbsService.lookupCustomerByPhone(phone).then(r => { cbsLookup = r; }),
        verificationPhoneOrEmail && verificationInfo.method === 'phone'
          ? customerService.getAccountsListByPhone(verificationPhoneOrEmail).then(r => { isInternal = r && r.length > 0; })
          : Promise.resolve(),
      ]);

      if (customerAccounts.length > 0) {
        console.log(`✅ Customer ${phone} found in CBS with ${customerAccounts.length} account(s)`);
      } else {
        console.log(`ℹ️ Customer ${phone} not found in CBS - proceeding anyway`);
      }
      if (verificationPhoneOrEmail) {
        console.log(`🔍 Verification ${verificationInfo.method} ${verificationPhoneOrEmail} is ${isInternal ? 'INTERNAL' : 'EXTERNAL'}`);
      }

      let resolvedName = name || null;
      let resolvedEmail = socket.user.customerEmail || null;
      const isGuest = customerAccounts.length === 0;
      if (cbsLookup && cbsLookup.found) {
        if (!resolvedName) resolvedName = cbsLookup.name || null;
        if (!resolvedEmail && cbsLookup.email) resolvedEmail = cbsLookup.email;
      }
      if (!resolvedName) resolvedName = 'Guest';

      // SIMPLIFIED: All calls go to BullMQ queue - managers pick manually from dashboard
      const result = await addCustomerToQueue({
        customerPhone: phone,
        socketId: socketId,
        customerName: resolvedName,
        customerEmail: resolvedEmail,
        isGuest: isGuest,
        priority: 'NORMAL',
        verificationInfo: verificationInfo ? {
          method: verificationInfo.method,
          phoneOrEmail: verificationPhoneOrEmail,
          isInternal: isInternal, // true if verification phone/email is in bank, false if external
        } : null
      });

      if (result.success) {
        socket.emit("queue:added", {
          position: result.queuePosition,
          message: "You have been added to the queue. A manager will pick your call shortly.",
          jobId: result.jobId
        });

        await broadcastQueueAndStatus(io);
        console.log(`✅ Customer ${phone} added to queue at position ${result.queuePosition}`);
      } else if (result.alreadyInQueue) {
        socket.emit("queue:already", {
          position: result.queuePosition,
          message: "You are already in the queue.",
          jobId: result.jobId
        });
      } else {
        socket.emit("call:failed", {
          message: "Unable to initiate call. Please try again."
        });
      }
    };

    // REMOVED: call:accept and call:reject handlers
    // New queue-only design: Managers manually pick calls from dashboard using queue:pick-call
    // No more broadcast/accept/reject popups

    // Customer cancels call before acceptance
    socket.on("call:cancel", async () => {
      if (role !== "customer") return;

      console.log(`🚫 Customer ${phone} cancelling call before acceptance`);

      // Remove from BullMQ queue if in queue
      const wasInQueue = await removeCustomerFromQueue(phone);
      if (wasInQueue) {
        console.log(`📋 Customer ${phone} removed from BullMQ queue on cancel`);
        await broadcastQueueAndStatus(io);
        socket.emit("call:cancelled_confirmation", {
          message: "You have been removed from the queue",
        });
        return;
      }

      if (
        !activeCustomerCalls[phone] ||
        !activeCustomerCalls[phone].inProgress
      ) {
        console.log(`⚠️ No active call to cancel for customer ${phone}`);
        return;
      }

      const managerEmail = activeCustomerCalls[phone].currentManagerEmail;
      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === managerEmail
      )?.socketId;

      // Log cancelled call
      if (activeCustomerCalls[phone]?.callRoom) {
        try {
          await callLogService.cancelCall(activeCustomerCalls[phone].callRoom);
        } catch (err) {
          console.error("❌ Error logging cancelled call:", err);
        }
      }

      if (managerEmail && managerSocketId) {
        console.log(
          `📣 Notifying manager ${managerEmail} about call cancellation`
        );
        io.to(managerSocketId).emit("call:cancelled", {
          customerId: phone,
          message: "Customer cancelled the call request",
        });

        updateUserStatus(managerEmail, "manager", "online");
      }

      await clearActiveCustomerCall(phone, io);
      io.emit("manager:list", findAvailableManagers());

      socket.emit("call:cancelled_confirmation", {
        message: "Call request successfully cancelled",
      });
    });

    // Customer updates their info (email, name, account number)
    socket.on("customer:update-info", async (data) => {
      if (role !== "customer") return;

      const { customerEmail, customerName, customerAccountNumber } = data;

      // Update in active call data
      if (activeCustomerCalls[phone]) {
        if (customerEmail) activeCustomerCalls[phone].customerEmail = customerEmail;
        if (customerName) activeCustomerCalls[phone].customerName = customerName;
        if (customerAccountNumber) activeCustomerCalls[phone].customerAccountNumber = customerAccountNumber;
        touchCall(phone);

        // Update call log if exists
        if (activeCustomerCalls[phone].callLogId) {
          try {
            const { CallLog } = require("../models/CallLog");
            await CallLog.update(
              {
                ...(customerEmail && { customerEmail }),
                ...(customerName && { customerName }),
                ...(customerAccountNumber && { customerAccountNumber }),
              },
              { where: { id: activeCustomerCalls[phone].callLogId } }
            );
            console.log(`Customer ${phone} updated info: email=${customerEmail || 'unchanged'}`);
          } catch (err) {
            console.error("Error updating customer info:", err);
          }
        }
      }

      socket.emit("customer:info-updated", {
        message: "Customer info updated successfully",
        customerEmail,
        customerName,
      });
    });

    // Call end events
    socket.on("call:end", async (data = {}) => {
      // When the LiveKit reconnect timer fires (peer dropped WebRTC but socket stayed up),
      // the frontend emits { reason: "peer_timeout" }. Record these as system-ended with
      // correct attribution so call counts reflect who caused the disruption.
      const isPeerTimeout = data?.reason === "peer_timeout";
      if (role === "customer") {
        // socket.user.phone comes straight from the JWT/handshake and can be
        // formatted differently (e.g. with country code) than the normalized
        // key activeCustomerCalls is actually stored under — looking it up
        // with the raw `phone` here silently misses the entry (and thus never
        // notifies the manager) even when the call is very much active.
        const normalizedPhone = normalizePhone(phone);
        console.log(`🔄 Customer ${normalizedPhone} ended call`);

        // Self-heals across pods: the entry was created on whichever pod
        // hosts the MANAGER's socket, which may differ from this customer
        // connection's pod.
        await ensureLocalActiveCall(io, normalizedPhone);

        // Set immediately after the entry is guaranteed to exist locally, and
        // before any further awaits below, so a near-simultaneous "disconnect"
        // event (e.g. the tab closing right after End Call) sees this flag and
        // skips its reconnect-grace-period path instead of racing call:ended
        // with customer:reconnecting.
        if (activeCustomerCalls[normalizedPhone]) {
          activeCustomerCalls[normalizedPhone].callEndingByCustomer = true;
        }

        // Notify manager about call end BEFORE clearing state
        if (activeCustomerCalls[normalizedPhone]?.currentManagerEmail) {
          const managerEmail = activeCustomerCalls[normalizedPhone].currentManagerEmail;
          // Find current manager socket ID robustly
          const managerSocketId = getOnlineUsersWithInfo().find(
            (user) => user.email === managerEmail
          )?.socketId || activeCustomerCalls[normalizedPhone].managerSocketId;

          console.log(`📣 Notifying manager ${managerEmail} (socket: ${managerSocketId}) about customer ${normalizedPhone} ending call`);

          if (managerSocketId) {
            // fetchSockets() is cluster-aware (via the Redis adapter); io.sockets.sockets.get()
            // only sees sockets local to this pod, causing false negatives with multiple replicas.
            const managerSockets = await io.in(managerSocketId).fetchSockets();
            if (managerSockets.length > 0) {
              const eventData = {
                customerId: phone,
                customerName: name || null,
                endedBy: "customer",
                callLogId: activeCustomerCalls[normalizedPhone].callLogId || null,
                referenceNumber: activeCustomerCalls[normalizedPhone].referenceNumber || null,
              };
              io.to(managerSocketId).emit("call:ended", eventData);
              console.log(`✅ Successfully sent call:ended event to manager ${managerEmail} (socket: ${managerSocketId})`);
              console.log(`   Event data:`, JSON.stringify(eventData));
            } else {
              console.log(`⚠️ Manager socket ${managerSocketId} not found or not connected`);
            }
          } else {
            console.log(`⚠️ No manager socket ID found for customer ${normalizedPhone}`);
            console.log(`   Active call data:`, JSON.stringify(activeCustomerCalls[normalizedPhone]));
          }
        } else {
          console.log(`⚠️ No active call data found for customer ${normalizedPhone}`);
        }

        // Auto-stop recording
        const callData = activeCustomerCalls[normalizedPhone];
        if (callData?.egressId) {
          try {
            const recordingService = require('./recordingService');
            await recordingService.stopRecording(callData.egressId);
            console.log(`🛑 Auto-recording stopped for call ${callData.callRoom}`);
          } catch (recErr) {
            console.error("⚠️ Failed to auto-stop recording:", recErr.message);
          }
        } else if (callData?.callLogId) {
          // Self-healing: try to stop by callLogId if memory lost egressId
          try {
            const recordingService = require('./recordingService');
            await recordingService.stopRecordingForCall(callData.callLogId);
          } catch (err) {
            console.error("⚠️ Self-healing recording stop failed:", err.message);
          }
        }

        // CBS audit log — fire and forget, never blocks call cleanup
        const _callDataForLog = activeCustomerCalls[normalizedPhone];
        if (_callDataForLog?.cifNo) {
          cbsService.saveCustomerInfoLog({
            cifNo: _callDataForLog.cifNo,
            email: _callDataForLog.email || "",
            mobile: phone,
            purpose: "Video Banking Session",
            maker: _callDataForLog.currentManagerEmail || "",
          }).catch(() => null);
        }

        // Complete call log — peer_timeout means manager's LiveKit dropped, customer reports it
        if (activeCustomerCalls[normalizedPhone]?.callRoom) {
          try {
            const endedBy = isPeerTimeout ? "system" : "customer";
            const metadata = isPeerTimeout ? { disconnectedBy: "manager" } : undefined;
            await callLogService.completeCall(
              activeCustomerCalls[normalizedPhone].callRoom,
              endedBy,
              {
                phoneVerified: activeCustomerCalls[normalizedPhone].phoneVerified || false,
                emailVerified: activeCustomerCalls[normalizedPhone].emailVerified || false,
                faceVerified: activeCustomerCalls[normalizedPhone].faceVerified || false,
                chatMessagesCount: activeCustomerCalls[normalizedPhone].chatMessagesCount || 0,
                ...(metadata && { metadata }),
              }
            );
          } catch (err) {
            console.error("❌ Error completing call log:", err);
          }
        }

        // Clear call and reset manager status
        await clearActiveCustomerCall(normalizedPhone, io);

        // Notify customer that call has ended (confirm their end request)
        socket.emit("call:ended", {
          endedBy: isPeerTimeout ? "system" : "customer",
          message: "Call ended successfully"
        });
        console.log(`✅ Sent call:ended confirmation to customer ${normalizedPhone}`);

        // Broadcast updated manager list so all managers see status change
        io.emit("manager:list", findAvailableManagers());
        console.log(`📣 Broadcasted updated manager list after customer ${phone} ended call`);

        // Emit stats-update event to trigger stats refresh on manager panels
        io.emit("stats:update", {
          event: "call-completed",
          timestamp: Date.now(),
          customerPhone: phone
        });
        console.log(`📊 Emitted stats:update event for customer ${phone} ending call`);

        // Broadcast updated queue and status to all clients (including admin panel)
        console.log(`🔍 Broadcasting updated status after customer ${phone} ended call`);
        await broadcastQueueAndStatus(io);
      } else if (role === "manager") {
        const customerPhone = socket.user.customerPhone;
        const callData = customerPhone && activeCustomerCalls[customerPhone];
        // Re-entrancy guard: a double-click or duplicate "call:end" emit can fire this
        // handler twice concurrently for the same call. Without this flag, the second
        // invocation reads callData before the first invocation's clearActiveCustomerCall()
        // runs, then crashes reading .customerSocketId off the already-cleared entry after
        // its own awaits resolve. Set synchronously (no await before this line) so the
        // check-and-set can't race.
        if (callData && !callData._ending) {
          callData._ending = true;
          console.log(
            `🔄 Manager ${email} ended call with customer ${customerPhone}`
          );

          // Auto-stop recording
          if (callData?.egressId) {
            try {
              const recordingService = require('./recordingService');
              await recordingService.stopRecording(callData.egressId);
              console.log(`🛑 Auto-recording stopped for call ${callData.callRoom}`);
            } catch (recErr) {
              console.error("⚠️ Failed to auto-stop recording:", recErr.message);
            }
          } else if (callData?.callLogId) {
            // Self-healing: try to stop by callLogId if memory lost egressId
            try {
              const recordingService = require('./recordingService');
              await recordingService.stopRecordingForCall(callData.callLogId);
            } catch (err) {
              console.error("⚠️ Self-healing recording stop failed:", err.message);
            }
          }

          // CBS audit log — fire and forget
          if (callData?.cifNo) {
            cbsService.saveCustomerInfoLog({
              cifNo: callData.cifNo,
              email: callData.email || "",
              mobile: customerPhone,
              purpose: "Video Banking Session",
              maker: email || "",
            }).catch(() => null);
          }

          // Complete call log — peer_timeout means customer's LiveKit dropped, manager reports it
          if (callData?.callRoom) {
            try {
              const endedBy = isPeerTimeout ? "system" : "manager";
              const metadata = isPeerTimeout ? { disconnectedBy: "customer" } : undefined;
              await callLogService.completeCall(
                callData.callRoom,
                endedBy,
                {
                  phoneVerified: callData.phoneVerified || false,
                  emailVerified: callData.emailVerified || false,
                  faceVerified: callData.faceVerified || false,
                  chatMessagesCount: callData.chatMessagesCount || 0,
                  ...(metadata && { metadata }),
                }
              );
            } catch (err) {
              console.error("❌ Error completing call log:", err);
            }
          }

          // Notify customer that manager ended the call
          const customerSocketId = callData.customerSocketId;
          // fetchSockets() is cluster-aware (via the Redis adapter); io.sockets.sockets.get()
          // only sees sockets local to this pod, causing false negatives with multiple replicas.
          const customerSockets = customerSocketId ? await io.in(customerSocketId).fetchSockets() : [];

          console.log(`📤 Preparing to send call:ended to customer ${customerPhone}`);
          console.log(`   Customer socket ID: ${customerSocketId}`);
          console.log(`   Customer socket connected: ${customerSockets.length > 0}`);

          if (customerSockets.length > 0) {
            io.to(customerSocketId).emit("call:ended", {
              managerId: email,
              managerName: name || null,
              endedBy: "manager"
            });
            console.log(`✅ Sent call:ended event to customer ${customerPhone}`);
          } else {
            console.log(`⚠️ Cannot send call:ended - customer ${customerPhone} socket not found or disconnected`);
          }

          // Notify manager that call has ended (confirm their end request; include callLogId for post-call report)
          socket.emit("call:ended", {
            endedBy: "manager",
            customerId: customerPhone,
            message: "Call ended successfully",
            callLogId: callData.callLogId || null,
            referenceNumber: callData.referenceNumber || null,
          });
          console.log(`✅ Sent call:ended confirmation to manager ${email}`);

          // Clear active customer call state
          await clearActiveCustomerCall(customerPhone, io);
        } else {
          // If no active call found, just reset manager status
          updateUserStatus(email, role, "online");
        }

        // Broadcast updated manager list
        io.emit("manager:list", findAvailableManagers());
        console.log(`📣 Manager ${email} ended call and status set to online`);

        // Emit stats-update event to trigger stats refresh on manager panels
        io.emit("stats:update", {
          event: "call-completed",
          timestamp: Date.now(),
          managerEmail: email
        });
        console.log(`📊 Emitted stats:update event for manager ${email} ending call`);

        // Broadcast updated queue to all managers (no automatic routing in queue-only design)
        console.log(`🔍 Manager ${email} is now available - refreshing queue for all managers`);
        await broadcastQueueAndStatus(io);
      }
    });

    // Manager status management
    socket.on("manager:busy", () => {
      if (role === "manager") {
        console.log(`🔄 Manager ${email} set status to busy`);
        updateUserStatus(email, role, AGENT_STATUS.BUSY);
        broadcastQueueAndStatus(io);
      }
    });

    socket.on("manager:free", async () => {
      if (role === "manager") {
        console.log(`🔄 Manager ${email} set status to online`);
        updateUserStatus(email, role, AGENT_STATUS.ONLINE);
        await broadcastQueueAndStatus(io);
        // Queue-only design: No automatic routing, managers pick manually
      }
    });

    // Extended agent status management
    socket.on("manager:set-status", async (data) => {
      if (role !== "manager") return;

      const { status } = data;
      const validStatuses = Object.values(AGENT_STATUS);

      if (!validStatuses.includes(status)) {
        return socket.emit("call:error", { message: "Invalid status" });
      }

      console.log(`🔄 Manager ${email} set status to ${status}`);
      updateUserStatus(email, role, status);
      await broadcastQueueAndStatus(io);

      socket.emit("manager:status-updated", { status });

      // Queue-only design: No automatic routing, managers pick manually from queue
    });

    // Get current agent status
    socket.on("manager:get-status", () => {
      if (role !== "manager") return;

      const managers = getAllManagers();
      const currentManager = managers.find(m => m.email === email);

      // Return the current status (restored from Redis or default to online)
      const currentStatus = currentManager?.status || AGENT_STATUS.ONLINE;
      socket.emit("manager:current-status", {
        status: currentStatus,
        statusChangedAt: currentManager?.statusChangedAt
      });
      console.log(`📊 Manager ${email} requested status - returning: ${currentStatus}`);
    });

    // Get all managers list (for admin/supervisor)
    socket.on("admin:get-managers", () => {
      socket.emit("admin:managers-list", getAllManagers());
    });

    // Recording management (Admin/Supervisor use recordingService; Manager uses Recording model)
    socket.on("recording:start", async (data) => {
      if (isAdmin || role === 'supervisor') {
        const { roomName, customerPhone: targetPhone, managerEmail: targetManager, callLogId } = data;
        try {
          const recordingService = require('./recordingService');
          const result = await recordingService.startRecording(roomName, {
            customerPhone: targetPhone,
            managerEmail: targetManager,
            callLogId,
            recordedBy: email
          });
          socket.emit("recording:started", result);
          io.emit("recording:status", { roomName, status: 'recording', recordingId: result.recordingId });
          console.log(`🎬 Recording started by admin/supervisor ${email} for room ${roomName}`);
        } catch (error) {
          socket.emit("recording:error", { message: error.message });
        }
      } else if (role === "manager") {
        const customerPhone = socket.user.customerPhone;
        if (!customerPhone || !activeCustomerCalls[customerPhone]) {
          return socket.emit("call:error", { message: "No active call" });
        }
        const call = activeCustomerCalls[customerPhone];
        if (call.isRecording) {
          return socket.emit("call:error", { message: "Recording already in progress" });
        }
        try {
          const recording = await Recording.create({
            callLogId: call.callLogId || null,
            callRoom: call.callRoom,
            customerPhone,
            managerEmail: email,
            status: 'recording',
            startTime: new Date(),
            recordedBy: email,
            metadata: { initiatedVia: 'socket' }
          });
          call.isRecording = true;
          call.recordingId = recording.id;
          call.recordingStartTime = Date.now();
          touchCall(customerPhone);
          io.to(call.customerSocketId).emit("call:recording-started", {
            recordingId: recording.id,
            message: "This call is being recorded",
            timestamp: Date.now()
          });
          socket.emit("recording:started", { recordingId: recording.id, startTime: call.recordingStartTime });
          if (call.supervisors) {
            call.supervisors.forEach(supervisor => {
              io.to(supervisor.socketId).emit("call:recording-started", {
                customerPhone, recordingId: recording.id, startedBy: email
              });
            });
          }
          console.log(`🔴 Recording started for call ${customerPhone} by manager ${email}`);
        } catch (error) {
          console.error("❌ Error starting recording:", error);
          socket.emit("call:error", { message: "Failed to start recording" });
        }
      } else {
        socket.emit("call:error", { message: "Unauthorized" });
      }
    });

    socket.on("recording:stop", async (data) => {
      if (isAdmin || role === 'supervisor') {
        const { egressId, recordingId, roomName } = data;
        try {
          const recordingService = require('./recordingService');
          const result = await recordingService.stopRecording(egressId);
          socket.emit("recording:stopped", result);
          if (roomName) {
            io.emit("recording:status", { roomName, status: 'stopped', recordingId });
          }
          console.log(`🛑 Recording stopped by admin/supervisor ${email}`);
        } catch (error) {
          socket.emit("recording:error", { message: error.message });
        }
      } else if (role === "manager") {
        const customerPhone = socket.user.customerPhone;
        if (!customerPhone || !activeCustomerCalls[customerPhone]) {
          return socket.emit("call:error", { message: "No active call" });
        }
        const call = activeCustomerCalls[customerPhone];
        if (!call.isRecording || !call.recordingId) {
          return socket.emit("call:error", { message: "No recording in progress" });
        }
        try {
          const duration = Math.floor((Date.now() - call.recordingStartTime) / 1000);
          await Recording.update(
            { status: 'processing', endTime: new Date(), duration },
            { where: { id: call.recordingId } }
          );
          const recordingId = call.recordingId;
          call.isRecording = false;
          delete call.recordingId;
          delete call.recordingStartTime;
          touchCall(customerPhone);
          io.to(call.customerSocketId).emit("call:recording-stopped", { recordingId, duration, timestamp: Date.now() });
          socket.emit("recording:stopped", { recordingId, duration });
          if (call.supervisors) {
            call.supervisors.forEach(supervisor => {
              io.to(supervisor.socketId).emit("call:recording-stopped", {
                customerPhone, recordingId, stoppedBy: email, duration
              });
            });
          }
          console.log(`⏹️ Recording stopped for call ${customerPhone}, duration: ${duration}s`);
        } catch (error) {
          console.error("❌ Error stopping recording:", error);
          socket.emit("call:error", { message: "Failed to stop recording" });
        }
      } else {
        socket.emit("call:error", { message: "Unauthorized" });
      }
    });

    // Call Hold — manager mutes their own audio/video and the customer sees a
    // hold screen instead of ending the call outright. Mirrors the
    // recording:start/stop pattern above.
    socket.on("call:hold", async (data) => {
      if (role !== "manager") {
        return socket.emit("call:error", { message: "Unauthorized" });
      }
      const customerPhone = socket.user.customerPhone;
      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "No active call" });
      }
      const call = activeCustomerCalls[customerPhone];
      if (call.isOnHold) {
        return socket.emit("call:error", { message: "Call is already on hold" });
      }
      try {
        call.isOnHold = true;
        call.holdStartTime = Date.now();
        touchCall(customerPhone);
        io.to(call.customerSocketId).emit("call:hold-started", {
          message: "The bank representative has put this call on hold",
          timestamp: call.holdStartTime,
        });
        socket.emit("call:hold-started", { timestamp: call.holdStartTime });
        if (call.supervisors) {
          call.supervisors.forEach((supervisor) => {
            io.to(supervisor.socketId).emit("call:hold-started", { customerPhone, heldBy: email });
          });
        }
        console.log(`⏸️ Call put on hold for ${customerPhone} by manager ${email}`);
      } catch (error) {
        console.error("❌ Error placing call on hold:", error);
        socket.emit("call:error", { message: "Failed to place call on hold" });
      }
    });

    socket.on("call:resume", async (data) => {
      if (role !== "manager") {
        return socket.emit("call:error", { message: "Unauthorized" });
      }
      const customerPhone = socket.user.customerPhone;
      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "No active call" });
      }
      const call = activeCustomerCalls[customerPhone];
      if (!call.isOnHold) {
        return socket.emit("call:error", { message: "Call is not on hold" });
      }
      try {
        const duration = Math.floor((Date.now() - call.holdStartTime) / 1000);
        call.isOnHold = false;
        delete call.holdStartTime;
        touchCall(customerPhone);
        io.to(call.customerSocketId).emit("call:hold-ended", { duration, timestamp: Date.now() });
        socket.emit("call:hold-ended", { duration });
        if (call.supervisors) {
          call.supervisors.forEach((supervisor) => {
            io.to(supervisor.socketId).emit("call:hold-ended", { customerPhone, resumedBy: email, duration });
          });
        }
        console.log(`▶️ Call resumed for ${customerPhone} by manager ${email}, held for ${duration}s`);
      } catch (error) {
        console.error("❌ Error resuming call:", error);
        socket.emit("call:error", { message: "Failed to resume call" });
      }
    });

    socket.on("recording:status", async (data) => {
      if (isAdmin || role === 'supervisor') {
        const { egressId } = data;
        try {
          const recordingService = require('./recordingService');
          const result = await recordingService.getRecordingStatus(egressId);
          socket.emit("recording:status-update", result);
        } catch (error) {
          socket.emit("recording:error", { message: error.message });
        }
      } else {
        const customerPhone = socket.user.customerPhone || data?.customerPhone;
        if (!customerPhone || !activeCustomerCalls[customerPhone]) {
          return socket.emit("recording:status-response", { isRecording: false });
        }
        const call = activeCustomerCalls[customerPhone];
        socket.emit("recording:status-response", {
          isRecording: call.isRecording || false,
          recordingId: call.recordingId || null,
          startTime: call.recordingStartTime || null,
          duration: call.recordingStartTime ? Math.floor((Date.now() - call.recordingStartTime) / 1000) : 0
        });
      }
    });

    // Queue management
    socket.on("queue:get", async () => {
      const [queue, stats] = await Promise.all([
        getQueuedCustomers(),
        getQueueStats()
      ]);
      socket.emit("queue:list", { queue, stats });
    });

    // Manager picks call from queue (manual routing)
    socket.on("queue:pick-call", async (data) => {
      if (role !== "manager") return;

      const { customerPhone: rawCustomerPhone } = data;
      const customerPhone = normalizePhone(rawCustomerPhone);

      // Get customer from queue before removing
      const queue = await getQueuedCustomers();
      const queueEntry = queue.find(q => normalizePhone(q.customerPhone) === customerPhone);

      if (!queueEntry) {
        return socket.emit("call:error", { message: "Customer not found in queue" });
      }

      // Check socket BEFORE removing from queue so a disconnected customer
      // stays in the queue list until the disconnect handler cleans it up,
      // allowing the manager to see the stale entry disappear rather than
      // getting a "not found" error on retry.
      // Uses fetchSockets() (cluster-aware via the Redis adapter) instead of
      // io.sockets.sockets.get(), which only sees sockets local to this pod —
      // with multiple backend replicas the customer's socket is often on a
      // different pod than the manager's, causing false "disconnected" errors.
      const customerSockets = await io.in(queueEntry.socketId).fetchSockets();
      if (customerSockets.length === 0) {
        return socket.emit("call:error", { message: "Customer has disconnected" });
      }

      // Remove from BullMQ queue
      const removed = await removeCustomerFromQueue(customerPhone);
      if (!removed) {
        return socket.emit("call:error", { message: "Failed to remove customer from queue" });
      }

      // Initiate call to this customer
      console.log(`📞 Manager ${email} picked call from queue for customer ${customerPhone}`);

      // Capture previous status BEFORE setting to busy so it can be restored on call end
      const allManagers = getAllManagers();
      const currentManager = allManagers.find(m => m.email === email);
      const previousStatus = currentManager?.status || AGENT_STATUS.ONLINE;

      // Update manager status
      updateUserStatus(email, role, AGENT_STATUS.BUSY);

      // Create call room
      const callRoom = `room_${customerPhone}_${Date.now()}`;

      // Store active call with verification info
      const normalizedPhone = normalizePhone(customerPhone);

      // Get account number from CBS if possible
      let accountNumber = null;
      let customerCifNo = null;
      let customerEmailFromCBS = null;
      try {
        const lookup = await cbsService.lookupCustomerByPhone(normalizedPhone);
        if (lookup && lookup.found) {
          accountNumber = lookup.accountNumber;
          customerCifNo = lookup.customerCIF || lookup.cifNo || null;
          customerEmailFromCBS = lookup.email || null;
        }
      } catch (err) {
        console.log(`ℹ️ CBS lookup failed for ${normalizedPhone}:`, err.message);
      }

      activeCustomerCalls[normalizedPhone] = {
        inProgress: false,
        customerSocketId: queueEntry.socketId,
        managerSocketId: socket.id, // CRITICAL: Store manager socket ID for call:ended notification
        attemptedManagers: new Set([email]),
        currentManagerEmail: email,
        timeout: null,
        startTime: Date.now(),
        customerPhone: normalizedPhone,
        customerName: queueEntry.customerName || null,
        customerEmail: queueEntry.customerEmail || null,
        accountNumber: accountNumber, // Store for CBS updates later
        cifNo: customerCifNo, // Store for CBS audit logging at call end
        email: customerEmailFromCBS || queueEntry.customerEmail || null,
        callRoom: callRoom,
        verificationInfo: queueEntry.verificationInfo || null, // { method: 'phone'|'email', phoneOrEmail: '...', isInternal: true|false }
        managerPreviousStatus: previousStatus,
      };
      touchCall(normalizedPhone);

      socket.user.customerPhone = normalizedPhone;

      // Create call log entry
      let createdCallLog = null;
      try {
        createdCallLog = await callLogService.createCallLog({
          callRoom: callRoom,
          customerPhone: customerPhone,
          customerName: queueEntry.customerName || null,
          customerEmail: queueEntry.customerEmail || null,
          managerEmail: email,
          managerName: name || null,
          queueWaitTime: queueEntry.waitTimeSeconds || 0,
          metadata: { pickedFromQueue: true }
        });
        // The customer can race this (e.g. queue:leave from a tab refresh)
        // while the two awaits above are in flight, deleting this entry via
        // clearActiveCustomerCall before we get here — guard every access
        // instead of crashing the whole pod on an uncaught TypeError.
        if (activeCustomerCalls[normalizedPhone]) {
          activeCustomerCalls[normalizedPhone].callLogId = createdCallLog?.id;
          activeCustomerCalls[normalizedPhone].referenceNumber = createdCallLog?.referenceNumber;
          touchCall(normalizedPhone);
        }
        await callLogService.acceptCall(callRoom);

        // Auto-start recording after delay (wait for participants to join)
        setTimeout(async () => {
          try {
            if (!activeCustomerCalls[normalizedPhone]) {
              console.log("⚠️ Call ended before recording could start");
              return;
            }

            const recordingService = require('./recordingService');

            // Retry up to 3 times with 3s delay between attempts
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const recordingResult = await recordingService.startRecording(
                  callRoom,
                  {
                    customerPhone: customerPhone,
                    managerEmail: email,
                    callLogId: createdCallLog?.id,
                    recordedBy: 'auto'
                  }
                );
                if (recordingResult.success) {
                  if (activeCustomerCalls[normalizedPhone]) {
                    activeCustomerCalls[normalizedPhone].egressId = recordingResult.egressId;
                    activeCustomerCalls[normalizedPhone].recordingId = recordingResult.recordingId;
                    touchCall(normalizedPhone);
                  }
                  console.log(`🎬 Auto-recording started for call ${callRoom}`);
                  return;
                }
              } catch (err) {
                if (attempt < 3 && err.message.includes('does not exist')) {
                  console.log(`⏳ Room not ready, retrying recording (${attempt}/3)...`);
                  await new Promise(r => setTimeout(r, 3000));
                } else {
                  throw err;
                }
              }
            }
          } catch (recErr) {
            console.error("⚠️ Failed to auto-start recording:", recErr.message);
          }
        }, 5000); // Wait 5 seconds for participants to join
      } catch (err) {
        console.error("Error creating call log:", err);
      }

      if (!activeCustomerCalls[normalizedPhone]) {
        console.log(`⚠️ Customer ${normalizedPhone} left before call routing completed — aborting call:accepted`);
        // updateUserStatus(email, role, AGENT_STATUS.BUSY) above already ran
        // before this point — without reverting it here, the manager gets
        // stuck permanently "busy" (unable to pick any future call) even
        // though no call is actually active.
        updateUserStatus(email, role, previousStatus);
        socket.emit("call:error", { message: "Customer is no longer available" });
        await broadcastQueueAndStatus(io);
        io.emit("manager:list", findAvailableManagers());
        return;
      }

      const referenceNumber = activeCustomerCalls[normalizedPhone].referenceNumber || null;

      // Notify manager that call is starting (sets callStatus='in-call' in manager panel)
      socket.emit("call:accepted", {
        customerId: customerPhone,
        customerPhone: customerPhone,
        customerName: queueEntry.customerName || null,
        customerEmail: queueEntry.customerEmail || null,
        callRoom: callRoom,
        referenceNumber,
        routingTime: queueEntry.waitTimeSeconds * 1000 || 0,
        verificationInfo: queueEntry.verificationInfo || null, // { method: 'phone'|'email', phoneOrEmail: '...', isInternal: true|false }
      });

      // Notify customer that manager accepted
      io.to(queueEntry.socketId).emit("call:accepted", {
        managerId: email,
        managerName: name || null,
        ...(socket.user.image && { managerImage: socket.user.image }),
        callRoom: callRoom,
        referenceNumber,
        routingTime: queueEntry.waitTimeSeconds * 1000 || 0
      });

      await broadcastQueueAndStatus(io);
      io.emit("manager:list", findAvailableManagers());
    });

    // Customer leaves queue
    socket.on("queue:leave", async (data) => {
      if (role !== "customer") return;

      console.log(`🚫 Customer ${phone} requested to leave queue`);

      try {
        // Remove from queue
        const removed = await removeCustomerFromQueue(phone);

        if (removed) {
          console.log(`✅ Customer ${phone} removed from queue`);
        }

        // Clear any active call data
        const normalizedPhone = normalizePhone(phone);
        if (activeCustomerCalls[normalizedPhone]) {
          await clearActiveCustomerCall(normalizedPhone, io);
        }

        // Notify customer they've left the queue
        socket.emit("queue:left", {
          message: "You have left the queue",
          timestamp: Date.now()
        });

        // Broadcast updated queue to all managers
        await broadcastQueueAndStatus(io);

      } catch (error) {
        console.error(`❌ Error removing customer ${phone} from queue:`, error);
        socket.emit("call:error", {
          message: "Failed to leave queue"
        });
      }
    });

    // Helper function to clear all pending customer requests before sending new one
    const clearCustomerRequests = (customerSocketId) => {
      io.to(customerSocketId).emit("cancel:all-requests", {
        message: "Previous request cancelled",
        timestamp: Date.now()
      });
    };

    socket.on("request:phone-verification", async (data) => {
      if (role !== "manager") return;

      let rawCustomerPhone = socket.user.customerPhone || data.customerPhone;

      if (!rawCustomerPhone) {
        const activeCallKey = Object.keys(activeCustomerCalls).find(
          key => activeCustomerCalls[key].currentManagerEmail === email
        );
        if (activeCallKey) {
          rawCustomerPhone = activeCallKey;
          socket.user.customerPhone = activeCallKey;
        }
      }

      const customerPhone = normalizePhone(rawCustomerPhone);
      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", {
          message: "No active call with customer found.",
        });
      }

      let customerSocketId = activeCustomerCalls[customerPhone].customerSocketId;

      // Validate stored socket is still active (cluster-aware, via Redis adapter);
      // if stale, search local sockets by phone as a last resort.
      if (!customerSocketId || (await io.in(customerSocketId).fetchSockets()).length === 0) {
        console.log(`⚠️ Stored customer socket ${customerSocketId} is stale, searching for active socket by phone ${customerPhone}`);
        for (const [, s] of io.sockets.sockets) {
          if (s.user && normalizePhone(s.user.phone) === customerPhone) {
            customerSocketId = s.id;
            activeCustomerCalls[customerPhone].customerSocketId = customerSocketId;
            touchCall(customerPhone);
            console.log(`✅ Found active customer socket: ${customerSocketId}`);
            break;
          }
        }
      }

      if (!customerSocketId) {
        console.error(`❌ No active socket found for customer ${customerPhone}`);
        return socket.emit("call:error", { message: "Customer is not connected." });
      }

      try {
        // Send phone OTP
        await OTP.sendtPhoneOtp(customerPhone);

        // Notify customer to open OTP modal
        io.to(customerSocketId).emit("requested:phone-verification", {
          message: "Manager has requested phone verification",
          managerId: email,
          managerName: name || null,
          phone: customerPhone
        });

        // Also notify manager that it's sent (for UI sync)
        socket.emit("verification:initiated", { type: 'phone', phone: customerPhone });
        console.log(`📱 Phone OTP sent and customer ${customerPhone} notified via socket ${customerSocketId}`);
      } catch (error) {
        console.error("❌ Error sending phone verification OTP:", error);
        socket.emit("call:error", { message: "Failed to send OTP to customer." });
      }
    });

    socket.on("customer:phone-verified", async (data) => {
      if (role !== "customer") return;

      const normalizedPhone = normalizePhone(phone);
      console.log(`✅ Customer ${normalizedPhone} verified phone number`);

      const activeCall = await ensureLocalActiveCall(io, normalizedPhone);
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      // Track verification in active call
      activeCustomerCalls[normalizedPhone].phoneVerified = true;
      touchCall(normalizedPhone);

      // Update call log
      if (activeCall.callRoom) {
        try {
          await callLogService.updateVerificationStatus(activeCall.callRoom, "phone", true);
        } catch (err) {
          console.error("❌ Error updating call log verification:", err);
        }
      }

      // Acknowledge back to customer
      socket.emit("customer:phone-verified", {
        phone: normalizedPhone,
        verified: true,
        message: "Phone number verified successfully",
      });

      const managerSocketId = activeCall.managerSocketId || getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:phone-verified", {
          customerId: phone,
          phone: normalizedPhone,
          verified: true,
          message: "Customer has verified their phone number",
          verificationTime: Date.now(),
        });

        console.log(
          `📣 Manager ${activeCall.currentManagerEmail} notified about customer ${phone} verification`
        );
      }
    });

    socket.on("request:email-verification", async (data) => {
      if (role !== "manager") return;

      let rawCustomerPhone = socket.user.customerPhone || data.customerPhone;

      if (!rawCustomerPhone) {
        const activeCallKey = Object.keys(activeCustomerCalls).find(
          key => activeCustomerCalls[key].currentManagerEmail === email
        );
        if (activeCallKey) {
          rawCustomerPhone = activeCallKey;
          socket.user.customerPhone = activeCallKey;
        }
      }

      const customerPhone = normalizePhone(rawCustomerPhone);
      const customerEmail = data.customerEmail;

      console.log(
        `🔄 Manager ${email} requesting email verification for customer ${customerPhone}`
      );

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      if (!customerEmail) {
        console.log(`⚠️ No email provided for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "Customer email is required",
        });
      }

      let customerSocketId = activeCustomerCalls[customerPhone].customerSocketId;

      // Validate stored socket is still active (cluster-aware, via Redis adapter);
      // if stale, search local sockets by phone as a last resort.
      if (!customerSocketId || (await io.in(customerSocketId).fetchSockets()).length === 0) {
        console.log(`⚠️ Stored customer socket ${customerSocketId} is stale, searching for active socket by phone ${customerPhone}`);
        for (const [, s] of io.sockets.sockets) {
          if (s.user && normalizePhone(s.user.phone) === customerPhone) {
            customerSocketId = s.id;
            activeCustomerCalls[customerPhone].customerSocketId = customerSocketId;
            touchCall(customerPhone);
            console.log(`✅ Found active customer socket: ${customerSocketId}`);
            break;
          }
        }
      }

      if (!customerSocketId) {
        console.error(`❌ No active socket found for customer ${customerPhone}`);
        return socket.emit("call:error", { message: "Customer is not connected." });
      }

      try {
        // Send email OTP
        await OTP.sendOTP(customerEmail);

        // Notify customer (modal trigger)
        io.to(customerSocketId).emit("requested:email-verification", {
          message: "Manager has requested email verification",
          managerId: email,
          managerName: name || null,
          email: customerEmail,
          customerEmail: customerEmail // Send both for compatibility
        });

        // Notify manager (sync)
        socket.emit("verification:initiated", { type: 'email', email: customerEmail });

        console.log(
          `📧 Verification email sent to ${customerEmail} for customer ${customerPhone}`
        );
      } catch (error) {
        console.error(`❌ Error sending email verification to ${customerEmail}: ${error.message}`);
        socket.emit("call:error", { message: "Failed to send email OTP to customer." });
      }
    });

    socket.on("customer:email-verified", async (data) => {
      if (role !== "customer") return;

      const normalizedPhone = normalizePhone(phone);
      console.log(`✅ Customer ${normalizedPhone} verified email address`);

      const activeCall = await ensureLocalActiveCall(io, normalizedPhone);
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      // Track verification in active call
      activeCustomerCalls[normalizedPhone].emailVerified = true;
      touchCall(normalizedPhone);

      // Update call log
      if (activeCall.callRoom) {
        try {
          await callLogService.updateVerificationStatus(activeCall.callRoom, "email", true);
        } catch (err) {
          console.error("❌ Error updating call log email verification:", err);
        }
      }

      // Acknowledge back to customer
      socket.emit("customer:email-verified", {
        email: data?.email,
        verified: true,
        message: "Email verified successfully",
      });

      const managerSocketId = activeCall.managerSocketId || getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:email-verified", {
          customerId: phone,
          phone: normalizedPhone,
          email: data?.email,
          verified: true,
          message: "Customer has verified their email address",
          verificationTime: Date.now(),
        });

        console.log(
          `📣 Manager ${activeCall.currentManagerEmail} notified about customer ${phone} email verification`
        );
      }
    });

    // Customer cancelled OTP verification
    socket.on("customer:verification-cancelled", (data) => {
      if (role !== "customer") return;

      const { phone: rawPhone, verificationType } = data;
      const normalizedPhone = normalizePhone(rawPhone);
      console.log(`🚫 Customer ${normalizedPhone} cancelled ${verificationType} verification`);

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      // Notify manager that customer cancelled verification
      const managerSocketId = activeCall.managerSocketId;
      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:verification-cancelled", {
          customerId: phone,
          verificationType: verificationType,
          message: `Customer cancelled ${verificationType} verification`,
          timestamp: Date.now(),
        });

        console.log(
          `📣 Manager ${activeCall.currentManagerEmail} notified that customer ${phone} cancelled ${verificationType} verification`
        );
      }
    });

    socket.on("change:phone-permission", () => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      console.log(
        `🔄 Manager ${email} requesting phone number change for customer ${customerPhone}`
      );

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      // Clear any previous requests first
      clearCustomerRequests(activeCustomerCalls[customerPhone].customerSocketId);

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "requested:phone-change",
        {
          message: "Manager has requested you to change your phone number",
          managerId: email,
          managerName: name || null,
        }
      );

      console.log(`📱 Phone change request sent to customer ${customerPhone}`);
    });

    // Customer typing phone number - NEW field
    socket.on("typing:phone-number-new", (data) => {
      if (role !== "customer") return;

      const { value } = data;
      const normalizedPhone = normalizePhone(phone);
      console.log(`🔄 Customer ${normalizedPhone} typing new phone number: ${value}`);

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      // Prefer stored manager socket ID (set when call started); fallback to cache lookup
      let managerSocketId = activeCall.managerSocketId;
      if (!managerSocketId) {
        managerSocketId = getOnlineUsersWithInfo().find(
          (user) => user.email === activeCall.currentManagerEmail
        )?.socketId;
      }

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:typing-phone-new", {
          customerId: phone,
          value,
          timestamp: Date.now(),
        });
      } else {
        console.log(`⚠️ No manager socket for customer ${phone} (manager: ${activeCall.currentManagerEmail})`);
      }
    });

    // Customer typing phone number - CONFIRM field
    socket.on("typing:phone-number-confirm", (data) => {
      if (role !== "customer") return;

      const { value } = data;
      const normalizedPhone = normalizePhone(phone);
      console.log(`🔄 Customer ${normalizedPhone} typing confirm phone number: ${value}`);

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      // Prefer stored manager socket ID (set when call started); fallback to cache lookup
      let managerSocketId = activeCall.managerSocketId;
      if (!managerSocketId) {
        managerSocketId = getOnlineUsersWithInfo().find(
          (user) => user.email === activeCall.currentManagerEmail
        )?.socketId;
      }

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:typing-phone-confirm", {
          customerId: phone,
          value,
          timestamp: Date.now(),
        });
      } else {
        console.log(`⚠️ No manager socket for customer ${phone} (manager: ${activeCall.currentManagerEmail})`);
      }
    });

    // Manager typing phone - NEW field - relay to customer
    socket.on("manager:typing-phone-new", (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      const { value } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return;
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "manager:typing-phone-new",
        {
          value,
          managerId: email,
          timestamp: Date.now(),
        }
      );
    });

    // Manager typing phone - CONFIRM field - relay to customer
    socket.on("manager:typing-phone-confirm", (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      const { value } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return;
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "manager:typing-phone-confirm",
        {
          value,
          managerId: email,
          timestamp: Date.now(),
        }
      );
    });

    // Manager typing email - NEW field - relay to customer
    socket.on("manager:typing-email-new", (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      const { value } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return;
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "manager:typing-email-new",
        {
          value,
          managerId: email,
          timestamp: Date.now(),
        }
      );
    });

    // Manager typing email - CONFIRM field - relay to customer
    socket.on("manager:typing-email-confirm", (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      const { value } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return;
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "manager:typing-email-confirm",
        {
          value,
          managerId: email,
          timestamp: Date.now(),
        }
      );
    });

    // Manager typing address - relay to customer
    socket.on("manager:typing-address", (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      const { newAddress, addressType } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return;
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "manager:typing-address",
        {
          newAddress,
          addressType,
          managerId: email,
          timestamp: Date.now(),
        }
      );
    });

    // Manager typing address change - individual fields (addressLine1, addressLine2, district, upazila, postCode)
    socket.on("manager:typing-address-change", (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      const { addressType, field, value } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return;
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "manager:typing-address-change",
        {
          addressType,
          field,
          value,
          managerId: email,
          timestamp: Date.now(),
        }
      );
    });

    // Customer uploaded address verification documents - notify manager
    socket.on("customer:address-documents-uploaded", (data) => {
      if (role !== "customer") return;

      const { files } = data;
      const normalizedPhone = normalizePhone(phone);
      const activeCall = activeCustomerCalls[normalizedPhone];

      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:address-documents-uploaded", {
          customerId: phone,
          files,
          timestamp: Date.now(),
        });
        console.log(`📎 Customer ${phone} uploaded ${files.length} document(s) for address verification`);
      }
    });

    // Customer removed a document - notify manager
    socket.on("customer:address-document-removed", (data) => {
      if (role !== "customer") return;

      const { fileIndex, files } = data;
      const normalizedPhone = normalizePhone(phone);
      const activeCall = activeCustomerCalls[normalizedPhone];

      if (!activeCall || !activeCall.currentManagerEmail) {
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:address-documents-updated", {
          customerId: phone,
          files,
          timestamp: Date.now(),
        });
      }
    });

    // ============================================================================
    // DORMANT ACCOUNT ACTIVATION - REAL-TIME TYPING EVENTS
    // ============================================================================

    // Customer typing account number (new field) - relay to manager
    socket.on("typing:account-number-new", (data) => {
      if (role !== "customer") return;

      const { accountNumber } = data;
      const normalizedPhone = normalizePhone(phone);
      console.log(
        `🔄 Customer ${normalizedPhone} typing new account number: ${accountNumber}`
      );

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:typing-account-number-new", {
          customerId: phone,
          accountNumber,
          timestamp: Date.now(),
        });
      }
    });

    // Customer typing account number (confirm field) - relay to manager
    socket.on("typing:account-number-confirm", (data) => {
      if (role !== "customer") return;

      const { accountNumber } = data;
      const normalizedPhone = normalizePhone(phone);
      console.log(
        `🔄 Customer ${normalizedPhone} typing confirm account number: ${accountNumber}`
      );

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:typing-account-number-confirm", {
          customerId: phone,
          accountNumber,
          timestamp: Date.now(),
        });
      }
    });

    // Customer extra compliance fields for dormant activation — relay to manager
    socket.on("customer:dormant-extra-fields", (data) => {
      if (role !== "customer") return;
      const normalizedPhone = normalizePhone(phone);
      if (!activeCustomerCalls[normalizedPhone]) return;

      const managerSocketId = getOnlineUsersWithInfo().find(
        (u) => u.email === activeCustomerCalls[normalizedPhone].currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:dormant-extra-fields", data);
      }

      // Cache on the active call so the approve handler can use it
      activeCustomerCalls[normalizedPhone].dormantExtraFields = data;
      touchCall(normalizedPhone);
    });

    // Manager typing account number (new field) - relay to customer
    socket.on("manager:typing-account-number-new", (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      const { accountNumber } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return;
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "manager:typing-account-number-new",
        {
          accountNumber,
          managerId: email,
          timestamp: Date.now(),
        }
      );
    });

    // Manager typing account number (confirm field) - relay to customer
    socket.on("manager:typing-account-number-confirm", (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      const { accountNumber } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return;
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "manager:typing-account-number-confirm",
        {
          accountNumber,
          managerId: email,
          timestamp: Date.now(),
        }
      );
    });

    socket.on("manager:sent-otp-change-phone", (data) => {
      if (role !== "manager") return;

      const { phone: rawPhone, accountNumber, timestamp } = data;
      const customerPhone = normalizePhone(socket.user.customerPhone);
      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      const newPhone = normalizePhone(rawPhone);
      console.log(`📱 Relaying phone-change OTP sent to customer ${customerPhone}, new phone: ${newPhone}`);
      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "customer:phone-change-otp-sent",
        {
          phone: newPhone,
          accountNumber: accountNumber,
          timestamp: timestamp,
        }
      );
    });

    socket.on("customer:phone-changed", (data) => {
      if (role !== "customer") return;

      const { newPhoneNumber, accountNumber, timestamp } = data;
      const normalizedPhone = normalizePhone(phone);

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:phone-changed", {
          newPhoneNumber: newPhoneNumber,
          accountNumber: accountNumber,
          timestamp: timestamp,
        });
      }
    });

    // ============ EMAIL CHANGE EVENTS ============
    socket.on("change:email-permission", () => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      console.log(
        `🔄 Manager ${email} requesting email change for customer ${customerPhone}`
      );

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      // Clear any previous requests first
      clearCustomerRequests(activeCustomerCalls[customerPhone].customerSocketId);

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "requested:email-change",
        {
          message: "Manager has requested you to change your email",
          managerId: email,
          managerName: name || null,
        }
      );

      console.log(`📧 Email change request sent to customer ${customerPhone}`);
    });


    // Customer typing email - NEW field
    socket.on("typing:email-new", (data) => {
      if (role !== "customer") return;

      const { value } = data;
      const normalizedPhone = normalizePhone(phone);
      console.log(`🔄 Customer ${normalizedPhone} typing new email: ${value}`);

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:typing-email-new", {
          customerId: phone,
          value,
          timestamp: Date.now(),
        });
      }
    });

    // Customer typing email - CONFIRM field
    socket.on("typing:email-confirm", (data) => {
      if (role !== "customer") return;

      const { value } = data;
      const normalizedPhone = normalizePhone(phone);
      console.log(`🔄 Customer ${normalizedPhone} typing confirm email: ${value}`);

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:typing-email-confirm", {
          customerId: phone,
          value,
          timestamp: Date.now(),
        });
      }
    });

    socket.on("manager:sent-otp-change-email", (data) => {
      if (role !== "manager") return;

      const { email: newEmail, phone: customerMobile, accountNumber, timestamp } = data;
      const customerPhone = normalizePhone(socket.user.customerPhone);
      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "customer:email-change-otp-sent",
        {
          email: newEmail,
          phone: customerMobile,
          accountNumber: accountNumber,
          timestamp: timestamp,
        }
      );

      console.log(`📧 Email change OTP sent notification to customer ${customerPhone}`);
    });

    socket.on("customer:email-changed", (data) => {
      if (role !== "customer") return;

      const { email: newEmail, accountNumber, timestamp } = data;

      const normalizedPhone = normalizePhone(phone);
      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:email-changed", {
          newEmail: newEmail,
          accountNumber: accountNumber,
          timestamp: timestamp,
        });
      }

      console.log(`📧 Customer ${phone} email changed to ${newEmail}`);
    });
    // ============ END EMAIL CHANGE EVENTS ============

    // ============ FACE VERIFICATION EVENTS ============
    socket.on("manager:initiate-face-verification", async (data) => {
      if (role !== "manager") {
        console.error(`❌ Non-manager attempted to initiate face verification: ${role}`);
        return;
      }

      const customerPhone = normalizePhone(socket.user.customerPhone);
      console.log(`🤳 Manager ${email} initiated face verification for customer ${customerPhone || 'UNKNOWN'}`);

      if (!customerPhone) {
        console.error(`❌ Manager ${email} has no customerPhone set in socket.user`);
        return socket.emit("manager:face-verification-error", {
          message: "No active call with customer. Please ensure you have an active call.",
          error: "no_customer_phone"
        });
      }

      if (!activeCustomerCalls[customerPhone]) {
        console.error(`❌ No active call found for customer ${customerPhone}`);
        return socket.emit("manager:face-verification-error", {
          message: "No active call found. The customer may have disconnected.",
          error: "no_active_call"
        });
      }

      const customerSocketId = activeCustomerCalls[customerPhone].customerSocketId;

      if (!customerSocketId) {
        console.error(`❌ No customer socket ID found for ${customerPhone}`);
        return socket.emit("manager:face-verification-error", {
          message: "Customer socket not found. They may have disconnected.",
          error: "no_customer_socket"
        });
      }

      // Check if customer socket is still connected (cluster-aware, via Redis adapter)
      const customerSockets = await io.in(customerSocketId).fetchSockets();
      if (customerSockets.length === 0) {
        console.error(`❌ Customer socket ${customerSocketId} is not connected`);
        return socket.emit("manager:face-verification-error", {
          message: "Customer has disconnected.",
          error: "customer_disconnected"
        });
      }

      clearCustomerRequests(customerSocketId); // Clear any previous requests

      // Clear any existing timeout
      if (activeCustomerCalls[customerPhone].faceVerificationTimeout) {
        clearTimeout(activeCustomerCalls[customerPhone].faceVerificationTimeout);
      }

      // Set timeout (30 seconds) - if no response, notify manager
      const timeoutDuration = 30000; // 30 seconds
      const timeoutId = setTimeout(() => {
        console.warn(`⏱️ Face verification timeout for customer ${customerPhone}`);
        socket.emit("manager:capture-timeout", {
          customerPhone: customerPhone,
          message: "Customer didn't respond within 30 seconds"
        });
        // Clean up timeout reference
        if (activeCustomerCalls[customerPhone]) {
          delete activeCustomerCalls[customerPhone].faceVerificationTimeout;
          touchCall(customerPhone);
        }
      }, timeoutDuration);

      // Store timeout ID for cleanup
      activeCustomerCalls[customerPhone].faceVerificationTimeout = timeoutId;
      touchCall(customerPhone);

      io.to(customerSocketId).emit("manager:initiate-face-verification", {
        message: "Manager has initiated face verification",
        managerId: email,
        managerName: name || null,
        timestamp: Date.now()
      });

      // Confirm to manager that event was sent
      socket.emit("manager:face-verification-initiated", {
        customerPhone: customerPhone,
        timestamp: Date.now()
      });

      // Standardized initiation event
      socket.emit("verification:initiated", { type: 'face', phone: customerPhone });

      console.log(`✅ Manager initiated face verification event sent to customer ${customerPhone} (socket: ${customerSocketId})`);
    });

    // Customer acknowledges that they have seen the face verification notification
    socket.on("customer:face-verification-notification-acknowledged", (data) => {
      if (role !== "customer") return;

      const normalizedPhone = normalizePhone(phone);
      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:face-verification-notification-acknowledged", {
          customerId: phone,
          timestamp: Date.now(),
        });
        console.log(`✅ Customer ${normalizedPhone} acknowledged face verification notification. Manager ${activeCall.currentManagerEmail} notified.`);
      }
    });

    // Handle passive face verification success from manager
    socket.on("manager:face-verified", (data) => {
      if (role !== "manager") return;

      const { customerId, matchPercentage } = data;
      const normalizedCustomerId = normalizePhone(customerId);

      console.log(`✅ Manager ${email} confirmed face verification for ${normalizedCustomerId}`);

      const activeCall = activeCustomerCalls[normalizedCustomerId];
      if (!activeCall) {
        console.log(`⚠️ No active call found for face verification of ${normalizedCustomerId}`);
        return;
      }

      // Update call state
      activeCall.faceVerified = true;
      activeCall.faceMatchPercentage = matchPercentage;
      touchCall(normalizedCustomerId);

      // Notify both parties
      const eventData = {
        verified: true,
        matchPercentage,
        timestamp: Date.now()
      };

      // Notify manager (to update UI state)
      if (activeCall.managerSocketId) {
        io.to(activeCall.managerSocketId).emit("customer:face-verified", eventData);
      }

      // Notify customer
      if (activeCall.customerSocketId) {
        io.to(activeCall.customerSocketId).emit("customer:face-verified", eventData);
      }

      console.log(`✅ Face verification confirmed and broadcasted for ${normalizedCustomerId}`);
    });
    // ============ END FACE VERIFICATION EVENTS ============

    // ============ SIGNATURE VERIFICATION EVENTS ============
    socket.on("manager:request-signature-upload", (data) => {
      if (role !== "manager") return;

      const { customerId } = data;
      const customerPhone = normalizePhone(customerId || socket.user.customerPhone);
      console.log(`✍️ Manager ${email} requesting signature upload from customer ${customerPhone}`);

      const activeCall = activeCustomerCalls[customerPhone];
      if (!activeCall) {
        console.log(`⚠️ No active call found for signature request. Normalized Phone: ${customerPhone}. Active keys:`, Object.keys(activeCustomerCalls));
        return socket.emit("call:error", { message: "No active call found with this customer" });
      }

      // Ensure manager socket ID is fresh
      activeCall.managerSocketId = socket.id;
      touchCall(customerPhone);

      // Find current customer socket ID robustly
      const customerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.phone === customerPhone
      )?.socketId || activeCall.customerSocketId;

      if (!customerSocketId) {
        return socket.emit("call:error", { message: "Customer is not currently connected" });
      }

      // Clear previous requests
      clearCustomerRequests(customerSocketId);

      io.to(customerSocketId).emit("manager:request-signature-upload", {
        message: "Manager has requested your signature upload",
        managerId: email,
        managerName: name || null,
        timestamp: Date.now()
      });
      console.log(`✅ Signature upload request sent to customer ${customerPhone} (socket: ${customerSocketId})`);

      // Standardized initiation event
      socket.emit("verification:initiated", { type: 'signature', phone: customerPhone });
    });

    socket.on("customer:signature-uploaded", async (data) => {
      if (role !== "customer") return;

      const { signaturePath, timestamp } = data;
      const normalizedPhone = normalizePhone(phone);
      console.log(`✍️ Customer ${normalizedPhone} uploaded signature: ${signaturePath}`);

      const activeCall = await ensureLocalActiveCall(io, normalizedPhone);
      console.log(`🔍 Active call lookup for customer ${normalizedPhone}:`, activeCall ? 'FOUND' : 'NOT FOUND');

      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call data for customer ${normalizedPhone} signature upload. Active keys:`, Object.keys(activeCustomerCalls));
        socket.emit("customer:signature-upload-acknowledged", {
          success: false,
          message: "No active call found on server"
        });
        return;
      }

      console.log(`📣 Target manager for signature: ${activeCall.currentManagerEmail}`);

      // Find current manager socket ID robustly
      const onlineUsers = getOnlineUsersWithInfo();
      const targetManager = onlineUsers.find(
        (user) => user.email === activeCall.currentManagerEmail
      );

      // Priority: 1. Current online socket, 2. Stored socket in call data
      const managerSocketId = targetManager?.socketId || activeCall.managerSocketId;

      console.log(`📡 Signature Sync: Forwarding to manager ${activeCall.currentManagerEmail}`);
      console.log(`📡 Detail: Found in online cache: ${!!targetManager}. Target Socket: ${managerSocketId}`);

      if (managerSocketId) {
        // Convert MinIO URL to base64 so manager panel can display it without public URL access
        let signatureData = signaturePath;
        const minioPublic = (process.env.MINIO_PUBLIC_URL || "").replace(/\/$/, "");
        if (minioPublic && signaturePath && signaturePath.startsWith(minioPublic)) {
          try {
            const { GetObjectCommand } = require("@aws-sdk/client-s3");
            const s3Client = require("../configs/s3Client");
            const objectPath = signaturePath.slice(minioPublic.length).replace(/^\//, "");
            const slashIdx = objectPath.indexOf("/");
            const bucket = slashIdx > -1 ? objectPath.slice(0, slashIdx) : (process.env.MINIO_BUCKET || "vbrm");
            const key = slashIdx > -1 ? objectPath.slice(slashIdx + 1) : objectPath;
            const s3Res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            const chunks = [];
            for await (const chunk of s3Res.Body) chunks.push(chunk);
            const ext = key.split(".").pop().toLowerCase();
            const mime = ext === "png" ? "image/png" : "image/jpeg";
            signatureData = `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`;
          } catch (e) {
            console.warn(`⚠️ Could not fetch signature from MinIO, using URL: ${e.message}`);
          }
        }

        io.to(managerSocketId).emit("customer:signature-uploaded", {
          customerId: phone,
          signaturePath: signatureData,
          timestamp,
          managerEmail: activeCall.currentManagerEmail
        });
        console.log(`✅ SUCCESS: Signature of customer ${phone} forwarded to manager ${activeCall.currentManagerEmail} (socket: ${managerSocketId})`);

        // Acknowledge to customer
        socket.emit("customer:signature-upload-acknowledged", {
          success: true,
          message: "Signature forwarded to manager"
        });
      } else {
        console.log(`⚠️ No manager socket found for signature of customer ${phone} (Manager: ${activeCall.currentManagerEmail})`);
        socket.emit("customer:signature-upload-acknowledged", {
          success: false,
          message: "Could not find an active manager connection"
        });
      }
    });

    socket.on("manager:signature-verification-decision", (data) => {
      if (role !== "manager") return;

      const { customerId, decision, message } = data;
      const normalizedCustomerId = normalizePhone(customerId);
      console.log(`✍️ Manager ${email} decision for signature of ${normalizedCustomerId}: ${decision}`);

      if (!activeCustomerCalls[normalizedCustomerId]) return;
      activeCustomerCalls[normalizedCustomerId].managerSocketId = socket.id;
      touchCall(normalizedCustomerId);

      const customerSocketId = activeCustomerCalls[normalizedCustomerId].customerSocketId;

      if (customerSocketId) {
        const eventData = {
          decision,
          message: data.message || `Signature verification: ${decision.toUpperCase()}`,
          timestamp: Date.now()
        };

        // Notify customer
        io.to(customerSocketId).emit("customer:signature-verification-decision", eventData);

        // Notify manager as well for UI sync
        socket.emit("customer:signature-verification-decision", eventData);
      }

      // Update call flags
      if (decision === 'approve' || decision === 'approved') {
        activeCustomerCalls[normalizedCustomerId].signatureVerified = true;
        touchCall(normalizedCustomerId);
      }
    });
    // ============ END SIGNATURE VERIFICATION EVENTS ============

    // ============ ADDRESS CHANGE EVENTS ============
    socket.on("change:address-permission", () => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      console.log(
        `🔄 Manager ${email} requesting address change for customer ${customerPhone}`
      );

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      // Clear any previous requests first
      clearCustomerRequests(activeCustomerCalls[customerPhone].customerSocketId);

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "requested:address-change",
        {
          message: "Manager has requested you to change your address",
          managerId: email,
          managerName: name || null,
        }
      );

      console.log(`🏠 Address change request sent to customer ${customerPhone}`);
    });

    socket.on("typing:address", (data) => {
      if (role !== "customer") return;

      const { newAddress, addressType, currentAddress } = data;
      const normalizedPhone = normalizePhone(phone);
      console.log(`🔄 Customer ${normalizedPhone} typing address: ${newAddress?.substring(0, 30)}...`);

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:typing-address", {
          customerId: phone,
          newAddress,
          addressType,
          currentAddress,
          timestamp: Date.now(),
        });
      }
    });

    socket.on("manager:sent-otp-change-address", (data) => {
      if (role !== "manager") return;

      const { address, addressType, phone: customerMobile, accountNumber, timestamp } = data;
      const customerPhone = normalizePhone(socket.user.customerPhone);
      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "customer:address-change-otp-sent",
        {
          address: address,
          addressType: addressType,
          phone: customerMobile,
          accountNumber: accountNumber,
          timestamp: timestamp,
        }
      );

      console.log(`🏠 Address change OTP sent notification to customer ${customerPhone}`);
    });

    socket.on("customer:address-changed", (data) => {
      if (role !== "customer") return;

      const { address, addressType, accountNumber, timestamp } = data;
      const normalizedPhone = normalizePhone(phone);

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:address-changed", {
          newAddress: address,
          addressType: addressType,
          accountNumber: accountNumber,
          timestamp: timestamp,
        });
      }

      console.log(`🏠 Customer ${phone} address changed to ${address?.substring(0, 30)}...`);
    });
    // ============ END ADDRESS CHANGE EVENTS ============

    // ============ CHANGE REQUEST PANEL WORKFLOW ============
    // Manager triggers change requests (new event names for VideoCallSidebarNew)
    socket.on("manager:request-phone-change", () => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      console.log(`📱 Manager ${email} requesting phone change for customer ${customerPhone}`);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      // Clear any previous requests first
      clearCustomerRequests(activeCustomerCalls[customerPhone].customerSocketId);

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "requested:phone-change",
        {
          message: "Manager has requested you to change your phone number",
          managerId: email,
          managerName: name || null,
        }
      );

      console.log(`✅ Phone change request sent to customer ${customerPhone}`);
    });

    socket.on("manager:request-email-change", () => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      console.log(`📧 Manager ${email} requesting email change for customer ${customerPhone}`);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      // Clear any previous requests first
      clearCustomerRequests(activeCustomerCalls[customerPhone].customerSocketId);

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "requested:email-change",
        {
          message: "Manager has requested you to change your email",
          managerId: email,
          managerName: name || null,
        }
      );

      console.log(`✅ Email change request sent to customer ${customerPhone}`);
    });

    socket.on("manager:request-address-change", (data = {}) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      console.log(`🏠 Manager ${email} requesting address change for customer ${customerPhone}`);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      // Clear any previous requests first
      clearCustomerRequests(activeCustomerCalls[customerPhone].customerSocketId);

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "requested:address-change",
        {
          message: "Manager has requested you to change your address",
          managerId: email,
          managerName: name || null,
          accountData: data.accountData || null,
        }
      );

      console.log(`✅ Address change request sent to customer ${customerPhone}`);
    });

    // Customer real-time typing (phone/email changes)
    socket.on("customer:typing-change", (data) => {
      if (role !== "customer") return;

      const { changeType, field, value } = data;
      const normalizedPhone = normalizePhone(phone);
      const activeCall = activeCustomerCalls[normalizedPhone];

      if (!activeCall || !activeCall.currentManagerEmail) {
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:typing-change", {
          changeType,
          field,
          value,
        });
      }
    });

    // Customer real-time typing (address changes)
    socket.on("customer:typing-address-change", (data) => {
      if (role !== "customer") return;

      const { addressType, field, value } = data;
      const normalizedPhone = normalizePhone(phone);
      const activeCall = activeCustomerCalls[normalizedPhone];

      if (!activeCall || !activeCall.currentManagerEmail) {
        return;
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:typing-address-change", {
          addressType,
          field,
          value,
        });
      }
    });

    // Customer or Manager submits change request (phone/email)
    socket.on("customer:submit-change-request", async (data) => {
      // Allow both customer and manager to trigger this
      // If manager triggers it, it's a "submit on behalf" flow
      const { changeType, newValue, currentValue, verified } = data;

      // When manager triggers this, look up customer by customerPhone, not manager's own phone
      const lookupPhone = role === 'manager'
        ? normalizePhone(socket.user?.customerPhone)
        : normalizePhone(phone);

      const activeCall = await ensureLocalActiveCall(io, lookupPhone);

      console.log(`📝 ${role === 'manager' ? 'Manager' : 'Customer'} submitted ${changeType} change request for ${lookupPhone}: ${currentValue} → ${newValue}`);

      if (!activeCall) {
        console.log(`⚠️ No active call found for customer ${lookupPhone}`);
        return;
      }

      if (role === 'manager' && verified) {
        // Echo back to this manager's socket so ChangeRequestPanel opens the approval dialog
        socket.emit("customer:submit-change-request", {
          changeType,
          newValue,
          currentValue,
          verified: true
        });

        // Notify customer that the request is pending approval
        const customerSocketId = activeCall.customerSocketId;
        if (customerSocketId) {
          io.to(customerSocketId).emit("customer:change-request-completed", {
            changeType,
            newValue,
            verified: true
          });
          console.log(`✅ Notified customer ${lookupPhone} that ${changeType} change was completed by manager`);
        }

        // Audit record is created in manager:approve-change with method='manager_override'
        // to avoid a duplicate entry when ChangeRequestPanel approval fires.
      } else if (role === 'customer' && activeCall.currentManagerEmail) {
        // Customer submitted — forward to manager for acknowledgment
        const managerSocketId = getOnlineUsersWithInfo().find(
          (user) => user.email === activeCall.currentManagerEmail
        )?.socketId;

        if (managerSocketId) {
          io.to(managerSocketId).emit("customer:submit-change-request", {
            changeType,
            newValue,
            currentValue,
            verified: verified || false
          });
          console.log(`✅ Change request forwarded to manager ${activeCall.currentManagerEmail}`);
        }
      }
    });

    // customer:email-verified is handled above (merged into the authoritative handler)

    // Customer or Manager submits address change request
    socket.on("customer:submit-address-change-request", async (data) => {
      // Allow both customer and manager to trigger this
      const { addressType, addressData, oldAddress } = data;

      // When manager triggers this, look up customer by customerPhone, not manager's own phone
      const lookupPhone = role === 'manager'
        ? normalizePhone(socket.user?.customerPhone)
        : normalizePhone(phone);

      const activeCall = await ensureLocalActiveCall(io, lookupPhone);

      console.log(`📝 ${role === 'manager' ? 'Manager' : 'Customer'} submitted ${addressType} address change request for ${lookupPhone}`);
      console.log('📄 Address Data:', JSON.stringify(addressData, null, 2));

      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${lookupPhone}`);
        return;
      }

      // Always forward to manager for approval workflow
      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("customer:submit-address-change-request", {
          addressType,
          addressData,
          oldAddress,
        });
        console.log(`✅ Address change request forwarded to manager ${activeCall.currentManagerEmail}`);
      }

      // Also notify customer that address change is pending approval
      if (activeCall.customerSocketId) {
        io.to(activeCall.customerSocketId).emit("customer:submit-address-change-request", {
          addressType,
          addressData,
          oldAddress,
        });
      }
    });

    // customer:phone-verified is handled above (merged into the authoritative handler)

    socket.on("resend:otp", async (data) => {
      const { type, target } = data; // type: 'phone'|'email', target: phone or email string

      console.log(`🔄 Request to resend ${type} OTP to ${target}`);

      const normalizedPhone = normalizePhone(phone);
      const activeCall = activeCustomerCalls[normalizedPhone] ||
        Object.values(activeCustomerCalls).find(c => c.currentManagerEmail === email);

      if (!activeCall) return;

      const customerSocketId = activeCall.customerSocketId;
      const managerSocketId = activeCall.managerSocketId;

      try {
        if (type === 'phone') {
          // Normalize the target phone number for the OTP service
          const normalizedTarget = normalizePhone(target);
          await OTP.sendtPhoneOtp(normalizedTarget);
        } else if (type === 'email') {
          await OTP.sendOTP(target);
        }

        // Broadcast to both parties that resend was successful
        if (customerSocketId) io.to(customerSocketId).emit("otp:resent", { type, target, success: true });
        if (managerSocketId) io.to(managerSocketId).emit("otp:resent", { type, target, success: true });
      } catch (error) {
        console.error(`❌ Error resending ${type} OTP:`, error.message);
        socket.emit("call:error", { message: `Failed to resend ${type} OTP` });
      }
    });

    // Manager approves change (phone/email)
    socket.on("manager:approve-change", async (data) => {
      if (role !== "manager") return;

      const { changeType, customerId, newValue, currentValue, isOverride } = data;
      const normalizedCustomerId = normalizePhone(customerId);
      const { ChangeRequest } = require("../models/ChangeRequest");
      console.log(`✅ Manager ${email} approved ${changeType} change for customer ${normalizedCustomerId}: ${currentValue} → ${newValue}`);

      if (!activeCustomerCalls[normalizedCustomerId]) {
        console.log(`⚠️ No active call found for customer ${normalizedCustomerId}`);
        return;
      }

      try {
        const accountNumber = activeCustomerCalls[normalizedCustomerId].customerAccountNumber
          || activeCustomerCalls[normalizedCustomerId].accountNumber;

        // Preview payload in manager's browser immediately — before audit or CBS call
        const cbsEndpoint = changeType === "phone"
          ? "POST /cbs/api/v1/customer/phone/update"
          : "POST /cbs/api/v1/customer/email/update";
        const cbsPayload = changeType === "phone"
          ? { accountNumber, requestId: "MANAGER_APPROVAL", otp: "verified", newPhone: newValue }
          : { accountNumber, requestId: "MANAGER_APPROVAL", otp: "verified", newEmail: newValue };
        socket.emit("debug:cbs-call", { endpoint: cbsEndpoint, args: cbsPayload, timestamp: new Date().toISOString() });

        // Save audit record BEFORE CBS call — always captured regardless of CBS outcome
        const auditMethod = isOverride ? 'manager_override' : 'standard';
        const auditNotes = isOverride
          ? `Manager sent OTP to new ${changeType} and verified directly on behalf of customer. Account: ${accountNumber || 'N/A'}.`
          : `Manager approved ${changeType} change via approval dialog. Account: ${accountNumber || 'N/A'}.`;
        const crPhoneEmail = await ChangeRequest.create({
          referenceNumber: activeCustomerCalls[normalizedCustomerId]?.referenceNumber || null,
          customerId,
          managerId: socket.user.id,
          changeType,
          oldValue: currentValue || '',
          newValue,
          status: 'approved',
          method: auditMethod,
          notes: auditNotes,
          ipAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent']
        }).catch(err => { console.error('⚠️ Audit save failed (non-fatal):', err.message); return null; });

        // Generate and attach PDF form (non-blocking)
        if (crPhoneEmail) {
          generateFormPDF(changeType, {
            customerId,
            accountNumber,
            oldValue: currentValue || '',
            newValue,
            managerName:  socket.user.name  || email,
            managerEmail: email,
          }).then(urls => {
            if (urls.length > 0) {
              crPhoneEmail.update({ pdfUrls: JSON.stringify(urls) }).catch(() => {});
            }
          }).catch(err => console.error('⚠️ PDF generation failed:', err.message));
        }

        // Update CBS system
        if (changeType === "phone") {
          await emitCbsLog(
            "POST /cbs/api/v1/customer/phone/update",
            { accountNumber, requestId: "MANAGER_APPROVAL", otp: "verified", newPhone: newValue },
            () => cbsService.updatePhone(accountNumber, "MANAGER_APPROVAL", "verified", newValue)
          );
        } else if (changeType === "email") {
          await emitCbsLog(
            "POST /cbs/api/v1/customer/email/update",
            { accountNumber, requestId: "MANAGER_APPROVAL", otp: "verified", newEmail: newValue },
            () => cbsService.updateEmail(accountNumber, "MANAGER_APPROVAL", "verified", newValue)
          );
        }

        io.to(activeCustomerCalls[normalizedCustomerId].customerSocketId).emit(
          "customer:change-approved",
          {
            changeType,
            newValue,
            message: `Your ${changeType} change has been approved and updated successfully in banking system`,
          }
        );

        console.log(`✅ Approval notification sent to customer ${normalizedCustomerId}`);
      } catch (error) {
        console.error(`❌ Error approving ${changeType} change:`, error);
        socket.emit("call:error", { message: "Failed to update record in banking system" });
      }
    });

    // Manager rejects change (phone/email)
    socket.on("manager:reject-change", async (data) => {
      if (role !== "manager") return;

      const { changeType, customerId, reason, currentValue } = data;
      const normalizedCustomerId = normalizePhone(customerId);
      const { ChangeRequest } = require("../models/ChangeRequest");
      console.log(`❌ Manager ${email} rejected ${changeType} change for customer ${normalizedCustomerId}: ${reason}`);

      if (!activeCustomerCalls[normalizedCustomerId]) {
        console.log(`⚠️ No active call found for customer ${normalizedCustomerId}`);
        return;
      }

      try {
        // Create audit record
        await ChangeRequest.create({
          referenceNumber: activeCustomerCalls[normalizedCustomerId]?.referenceNumber || null,
          customerId,
          managerId: socket.user.id,
          changeType,
          oldValue: currentValue || '',
          newValue: '',
          status: 'rejected',
          rejectionReason: reason,
          ipAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent']
        });

        io.to(activeCustomerCalls[normalizedCustomerId].customerSocketId).emit(
          "customer:change-rejected",
          {
            changeType,
            reason,
            message: reason || `Your ${changeType} change request was not approved by the manager`,
          }
        );

        console.log(`✅ Rejection notification sent to customer ${normalizedCustomerId}`);
      } catch (error) {
        console.error(`❌ Error rejecting ${changeType} change:`, error);
        socket.emit("call:error", { message: "Failed to reject change request" });
      }
    });

    // Manager approves address change
    socket.on("manager:approve-address-change", async (data) => {
      if (role !== "manager") return;

      const { customerId, addressType, addressData, oldAddress } = data;
      const normalizedCustomerId = normalizePhone(customerId);
      const { ChangeRequest } = require("../models/ChangeRequest");
      console.log(`✅ Manager ${email} approved ${addressType} address change for customer ${normalizedCustomerId}`);

      if (!activeCustomerCalls[normalizedCustomerId]) {
        console.log(`⚠️ No active call found for customer ${normalizedCustomerId}`);
        return;
      }

      try {
        const accountNumber = activeCustomerCalls[normalizedCustomerId].customerAccountNumber
          || activeCustomerCalls[normalizedCustomerId].accountNumber;
        const formattedAddress = `${addressData.addressLine1}, ${addressData.addressLine2 ? addressData.addressLine2 + ", " : ""}${addressData.upazila}, ${addressData.district} - ${addressData.postCode}`;

        // Preview payload in manager's browser immediately
        socket.emit("debug:cbs-call", {
          endpoint: "POST /cbs/api/v1/customer/address/update",
          args: { accountNumber, requestId: "MANAGER_APPROVAL", otp: "verified", newAddress: formattedAddress, addressType },
          timestamp: new Date().toISOString()
        });

        // Save audit record BEFORE CBS call — always captured regardless of CBS outcome
        const crAddress = await ChangeRequest.create({
          referenceNumber: activeCustomerCalls[normalizedCustomerId]?.referenceNumber || null,
          customerId,
          managerId: socket.user.id,
          changeType: 'address',
          oldValue: oldAddress || '',
          newValue: JSON.stringify({ addressType, ...addressData }),
          status: 'approved',
          method: 'standard',
          notes: `Manager approved ${addressType} address change via approval dialog. Account: ${accountNumber || 'N/A'}. New address: ${formattedAddress}`,
          ipAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent']
        }).catch(err => { console.error('⚠️ Audit save failed (non-fatal):', err.message); return null; });

        // Generate and attach PDF form (non-blocking)
        if (crAddress) {
          generateFormPDF('address', {
            customerId,
            accountNumber,
            oldValue: oldAddress || '',
            newValue: JSON.stringify({ addressType, ...addressData }),
            managerName:  socket.user.name  || email,
            managerEmail: email,
          }).then(urls => {
            if (urls.length > 0) {
              crAddress.update({ pdfUrls: JSON.stringify(urls) }).catch(() => {});
            }
          }).catch(err => console.error('⚠️ PDF generation failed:', err.message));
        }

        // Update CBS system
        await emitCbsLog(
          "POST /cbs/api/v1/customer/address/update",
          { accountNumber, requestId: "MANAGER_APPROVAL", otp: "verified", newAddress: formattedAddress, addressType },
          () => cbsService.updateAddress(accountNumber, "MANAGER_APPROVAL", "verified", formattedAddress, addressType)
        );

        io.to(activeCustomerCalls[normalizedCustomerId].customerSocketId).emit(
          "customer:change-approved",
          {
            changeType: "address",
            addressType,
            addressData,
            message: `Your ${addressType} address change has been approved and updated successfully in banking system`,
          }
        );

        console.log(`✅ Approval notification sent to customer ${normalizedCustomerId}`);
      } catch (error) {
        console.error(`❌ Error approving address change:`, error);
        socket.emit("call:error", { message: "Failed to update address in banking system" });
      }
    });

    // Manager rejects address change
    socket.on("manager:reject-address-change", async (data) => {
      if (role !== "manager") return;

      const { customerId, addressType, reason } = data;
      const normalizedCustomerId = normalizePhone(customerId);
      const { ChangeRequest } = require("../models/ChangeRequest");
      console.log(`❌ Manager ${email} rejected ${addressType} address change for customer ${normalizedCustomerId}: ${reason}`);

      if (!activeCustomerCalls[normalizedCustomerId]) {
        console.log(`⚠️ No active call found for customer ${normalizedCustomerId}`);
        return;
      }

      try {
        // Create audit record
        await ChangeRequest.create({
          referenceNumber: activeCustomerCalls[normalizedCustomerId]?.referenceNumber || null,
          customerId,
          managerId: socket.user.id,
          changeType: 'address',
          newValue: JSON.stringify({ addressType }),
          status: 'rejected',
          rejectionReason: reason,
          ipAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent']
        });

        io.to(activeCustomerCalls[normalizedCustomerId].customerSocketId).emit(
          "customer:change-rejected",
          {
            changeType: "address",
            addressType,
            reason,
            message: reason || `Your ${addressType} address change request was not approved by the manager`,
          }
        );

        console.log(`✅ Rejection notification sent to customer ${normalizedCustomerId}`);
      } catch (error) {
        console.error(`❌ Error rejecting address change:`, error);
        socket.emit("call:error", { message: "Failed to reject address change" });
      }
    });

    // Manager approves account activation
    socket.on("manager:approve-account-activation", async (data) => {
      if (role !== "manager") return;

      const { accountNumber } = data;

      // Use socket.user.customerPhone (set when manager joins the call) as the
      // authoritative key — it's already normalized and guaranteed to match
      // activeCustomerCalls. Fall back to the client-supplied customerId only if
      // customerPhone is absent (shouldn't happen in a live call).
      const customerPhone =
        normalizePhone(socket.user.customerPhone) ||
        normalizePhone(data.customerId);

      console.log(`✅ Manager ${email} approving account activation for customer ${customerPhone}`);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        socket.emit("account:activation-error", {
          message: "No active call found. Please ensure the call is still connected and try again.",
        });
        return;
      }

      const { ChangeRequest } = require("../models/ChangeRequest");
      try {
        socket.emit("debug:cbs-call", {
          endpoint: "POST /cbs/api/v1/account/activate",
          args: { accountNumber, requestId: "MANAGER_APPROVAL", otp: "verified", nidNumber: "" },
          timestamp: new Date().toISOString()
        });

        const extraFields = activeCustomerCalls[customerPhone]?.dormantExtraFields || {};
        const {
          estDepositCount, estDepositAmount,
          estWithdrawCount, estWithdrawAmount,
          dormancyReason,
        } = { ...extraFields, ...data };

        const activationNewValue = JSON.stringify({
          action: 'account_activation',
          accountNumber,
          estDepositCount:   estDepositCount   || null,
          estDepositAmount:  estDepositAmount  || null,
          estWithdrawCount:  estWithdrawCount  || null,
          estWithdrawAmount: estWithdrawAmount || null,
          dormancyReason:    dormancyReason    || null,
        });

        const crActivation = await ChangeRequest.create({
          referenceNumber: activeCustomerCalls[customerPhone]?.referenceNumber || null,
          customerId: customerPhone,
          managerId: socket.user.id,
          changeType: 'account_activation',
          newValue: activationNewValue,
          status: 'approved',
          method: 'standard',
          notes: `Manager approved dormant account activation. Account: ${accountNumber}. Deposits: ${estDepositCount || '?'}x BDT ${estDepositAmount || '?'}/mo. Withdrawals: ${estWithdrawCount || '?'}x BDT ${estWithdrawAmount || '?'}/mo. Reason: ${dormancyReason || 'not provided'}.`,
          ipAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent']
        }).catch(err => { console.error('⚠️ Audit save failed for account activation:', err.message); return null; });

        // Generate and attach both PDF forms (non-blocking)
        if (crActivation) {
          generateFormPDF('account_activation', {
            customerId:       customerPhone,
            accountNumber,
            newValue:         activationNewValue,
            estDepositCount,  estDepositAmount,
            estWithdrawCount, estWithdrawAmount,
            dormancyReason,
            managerName:  socket.user.name  || email,
            managerEmail: email,
          }).then(urls => {
            if (urls.length > 0) {
              crActivation.update({ pdfUrls: JSON.stringify(urls) }).catch(() => {});
            }
          }).catch(err => console.error('⚠️ PDF generation failed:', err.message));
        }

        await emitCbsLog(
          "POST /cbs/api/v1/account/activate",
          { accountNumber, requestId: "MANAGER_APPROVAL", otp: "verified", nidNumber: "" },
          () => cbsService.activateAccount(accountNumber, "MANAGER_APPROVAL", "verified", "")
        );

        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
          "customer:account-activated",
          {
            accountNumber,
            message: "Your dormant account has been successfully activated in the banking system",
          }
        );

        socket.emit("manager:account-activation-success", { accountNumber });
        console.log(`✅ Activation complete for customer ${customerPhone}`);
      } catch (cbsError) {
        console.error(`❌ CBS Activation Error:`, cbsError);
        socket.emit("account:activation-error", {
          message: cbsError.message || "Failed to activate account in banking system",
        });
      }
    });

    // Manager rejects account activation
    socket.on("manager:reject-account-activation", async (data) => {
      if (role !== "manager") return;

      const { accountNumber, reason } = data;
      const customerPhone =
        normalizePhone(socket.user.customerPhone) ||
        normalizePhone(data.customerId);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) return;

      const { ChangeRequest } = require("../models/ChangeRequest");
      await ChangeRequest.create({
        referenceNumber: activeCustomerCalls[customerPhone]?.referenceNumber || null,
        customerId: customerPhone,
        managerId: socket.user.id,
        changeType: 'account_activation',
        newValue: JSON.stringify({ action: 'account_activation', accountNumber }),
        status: 'rejected',
        rejectionReason: reason || 'Manager rejected activation',
        ipAddress: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent'],
      }).catch(err => console.error('⚠️ Audit save failed for activation rejection:', err.message));

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "customer:change-rejected",
        { changeType: "account_activation", reason: reason || "Your account activation was not approved by the manager." }
      );
    });
    // ============ END CHANGE REQUEST PANEL WORKFLOW ============

    // ============ REQUEST ASSISTANCE EVENTS ============
    socket.on("manager:request-assistance", (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      const { urgency = "normal", reason = "" } = data;

      console.log(`🆘 Manager ${email} requesting assistance for customer ${customerPhone}`);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      const assistanceRequest = {
        requestId: crypto.randomUUID(),
        managerEmail: email,
        managerName: name || null,
        customerPhone: customerPhone,
        callRoom: activeCustomerCalls[customerPhone].callRoom,
        urgency: urgency,
        reason: reason,
        timestamp: Date.now(),
        status: "pending"
      };

      // Store in active call
      activeCustomerCalls[customerPhone].assistanceRequest = assistanceRequest;
      touchCall(customerPhone);

      // Re-broadcast on an interval until a supervisor accepts, the manager
      // cancels, or it times out — per BRD: "continue notification until
      // admin/supervisor takes action."
      stopAssistanceTimers(customerPhone);
      const rebroadcast = () => io.emit("supervisor:assistance-requested", assistanceRequest);
      rebroadcast();
      const intervalId = setInterval(rebroadcast, ASSISTANCE_REPEAT_MS);
      const timeoutId = setTimeout(() => {
        stopAssistanceTimers(customerPhone);
        if (activeCustomerCalls[customerPhone]?.assistanceRequest?.requestId === assistanceRequest.requestId) {
          delete activeCustomerCalls[customerPhone].assistanceRequest;
          touchCall(customerPhone);
        }
        io.emit("supervisor:assistance-cancelled", {
          requestId: assistanceRequest.requestId,
          customerPhone,
          reason: "timeout",
          timestamp: Date.now(),
        });
        socket.emit("manager:assistance-cancelled", { message: "No supervisor responded in time", reason: "timeout" });
        console.log(`🆘 Assistance request timed out for ${customerPhone}`);
      }, ASSISTANCE_TIMEOUT_MS);
      assistanceTimers[customerPhone] = { intervalId, timeoutId };

      // Confirm to manager
      socket.emit("manager:assistance-requested", {
        requestId: assistanceRequest.requestId,
        message: "Assistance request sent to supervisor",
        timestamp: assistanceRequest.timestamp
      });

      console.log(`🆘 Assistance request broadcasted for call ${customerPhone}`);
    });

    socket.on("manager:cancel-assistance", (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return;
      }

      const assistanceRequest = activeCustomerCalls[customerPhone].assistanceRequest;
      if (assistanceRequest) {
        stopAssistanceTimers(customerPhone);
        assistanceRequest.status = "cancelled";
        touchCall(customerPhone);

        // Broadcast cancellation
        io.emit("supervisor:assistance-cancelled", {
          requestId: assistanceRequest.requestId,
          managerEmail: email,
          customerPhone: customerPhone,
          timestamp: Date.now()
        });

        delete activeCustomerCalls[customerPhone].assistanceRequest;
        touchCall(customerPhone);

        socket.emit("manager:assistance-cancelled", {
          message: "Assistance request cancelled"
        });

        console.log(`🆘 Assistance request cancelled by manager ${email}`);
      }
    });

    socket.on("supervisor:respond-assistance", (data) => {
      // This can be used by supervisor to acknowledge/respond
      const { requestId, customerPhone: rawPhone, response } = data;
      const customerPhone = normalizePhone(rawPhone);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "Call not found" });
      }

      const managerEmail = activeCustomerCalls[customerPhone].currentManagerEmail;
      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === managerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("manager:assistance-response", {
          requestId: requestId,
          supervisorName: name || email,
          response: response,
          timestamp: Date.now()
        });

        if (activeCustomerCalls[customerPhone].assistanceRequest) {
          activeCustomerCalls[customerPhone].assistanceRequest.status = "responded";
          touchCall(customerPhone);
        }

        // First supervisor to accept wins — stop the repeating notification
        // and tell every other admin dashboard to drop the banner.
        if (response === "accepted") {
          stopAssistanceTimers(customerPhone);
          io.emit("supervisor:assistance-cancelled", {
            requestId: requestId,
            customerPhone,
            reason: "accepted",
            acceptedBy: name || email,
            timestamp: Date.now(),
          });
        }

        console.log(`🆘 Supervisor ${email} responded to assistance request for ${customerPhone}`);
      }
    });
    // ============ END REQUEST ASSISTANCE EVENTS ============

    // ============ SUPERVISOR MONITORING EVENTS ============
    // Get all active calls for supervisor dashboard
    socket.on("supervisor:get-active-calls", () => {
      console.log('📊 supervisor:get-active-calls - Total in memory:', Object.keys(activeCustomerCalls).length);
      Object.entries(activeCustomerCalls).forEach(([phone, call]) => {
        console.log(`  - ${phone}: manager=${call.currentManagerEmail}, inProgress=${call.inProgress}`);
      });
      const activeCalls = Object.entries(activeCustomerCalls)
        .filter(([_, call]) => call.currentManagerEmail)
        .map(([customerPhone, call]) => ({
          customerPhone,
          managerEmail: call.currentManagerEmail,
          callRoom: call.callRoom,
          startTime: call.startTime,
          isOnHold: call.isOnHold || false,
          assistanceRequested: !!call.assistanceRequest,
          assistanceRequest: call.assistanceRequest || null,
          phoneVerified: call.phoneVerified || false,
          emailVerified: call.emailVerified || false,
          faceVerified: call.faceVerified || false,
          supervisors: call.supervisors || []
        }));

      socket.emit("supervisor:active-calls", activeCalls);
      console.log(`Supervisor ${email} requested active calls list: ${activeCalls.length} calls`);
    });

    // ==================== CALL TRANSFER EVENTS ====================

    // Track pending transfers
    const pendingTransfers = {};

    // Manager initiates call transfer
    socket.on("call:transfer-initiate", async (data) => {
      if (role !== "manager") return;

      const { targetManagerEmail, reason } = data;
      const customerPhone = normalizePhone(socket.user.customerPhone);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "No active call to transfer" });
      }

      // Check if target manager is available
      const availableManagers = findAvailableManagers();
      const targetManager = availableManagers.find(m => m.email === targetManagerEmail);

      if (!targetManager) {
        return socket.emit("call:transfer-failed", {
          message: "Target manager is not available",
          targetManagerEmail
        });
      }

      // Create transfer request
      const transferId = `transfer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      pendingTransfers[transferId] = {
        fromManagerEmail: email,
        fromManagerName: name,
        fromSocketId: socketId,
        targetManagerEmail,
        targetManagerSocketId: targetManager.socketId,
        customerPhone,
        callRoom: activeCustomerCalls[customerPhone].callRoom,
        referenceNumber: activeCustomerCalls[customerPhone].referenceNumber,
        reason: reason || "Manager requested transfer",
        createdAt: Date.now()
      };

      // Notify target manager
      io.to(targetManager.socketId).emit("call:transfer-request", {
        transferId,
        fromManagerEmail: email,
        fromManagerName: name,
        customerPhone,
        customerName: activeCustomerCalls[customerPhone].customerName,
        referenceNumber: activeCustomerCalls[customerPhone].referenceNumber,
        reason: reason || "Manager requested transfer",
        callDuration: Math.floor((Date.now() - activeCustomerCalls[customerPhone].startTime) / 1000)
      });

      // Notify requesting manager
      socket.emit("call:transfer-pending", {
        transferId,
        targetManagerEmail,
        message: "Transfer request sent, waiting for acceptance"
      });

      console.log(`Call transfer initiated: ${email} -> ${targetManagerEmail} for customer ${customerPhone}`);

      // Auto-expire transfer after 30 seconds
      setTimeout(() => {
        if (pendingTransfers[transferId]) {
          delete pendingTransfers[transferId];
          socket.emit("call:transfer-expired", {
            transferId,
            message: "Transfer request expired"
          });
          io.to(targetManager.socketId).emit("call:transfer-expired", {
            transferId,
            message: "Transfer request expired"
          });
        }
      }, 30000);
    });

    // Target manager accepts transfer
    socket.on("call:transfer-accept", async (data) => {
      if (role !== "manager") return;

      const { transferId } = data;
      const transfer = pendingTransfers[transferId];

      if (!transfer) {
        return socket.emit("call:error", { message: "Transfer request not found or expired" });
      }

      if (transfer.targetManagerEmail !== email) {
        return socket.emit("call:error", { message: "You are not the target of this transfer" });
      }

      const customerPhone = normalizePhone(transfer.customerPhone);
      const activeCall = activeCustomerCalls[customerPhone];

      if (!activeCall) {
        delete pendingTransfers[transferId];
        return socket.emit("call:error", { message: "Call no longer active" });
      }

      // Update call with new manager
      const previousManager = activeCall.currentManagerEmail;
      activeCall.currentManagerEmail = email;
      touchCall(customerPhone);
      socket.user.customerPhone = customerPhone;

      // Update manager statuses
      updateUserStatus(previousManager, "manager", "online");
      updateUserStatus(email, "manager", "busy");

      // Notify original manager
      io.to(transfer.fromSocketId).emit("call:transfer-completed", {
        transferId,
        newManagerEmail: email,
        newManagerName: name,
        message: "Call transferred successfully"
      });

      // Notify customer
      if (activeCall.customerSocketId) {
        io.to(activeCall.customerSocketId).emit("call:manager-changed", {
          previousManager: transfer.fromManagerName,
          newManagerEmail: email,
          newManagerName: name,
          message: "Your call has been transferred to another representative",
          referenceNumber: activeCall.referenceNumber
        });
      }

      // Notify new manager (current socket)
      socket.emit("call:transfer-accepted", {
        transferId,
        customerPhone,
        customerName: activeCall.customerName,
        callRoom: activeCall.callRoom,
        referenceNumber: activeCall.referenceNumber,
        fromManager: transfer.fromManagerName
      });

      // Update call log with transfer info
      if (activeCall.callLogId) {
        try {
          const { CallLog } = require("../models/CallLog");
          await CallLog.update(
            {
              managerEmail: email,
              managerName: name,
              metadata: {
                ...(activeCall.metadata || {}),
                transferred: true,
                transferredFrom: previousManager,
                transferredAt: new Date().toISOString(),
                transferReason: transfer.reason
              }
            },
            { where: { id: activeCall.callLogId } }
          );
        } catch (err) {
          console.error("Error updating call log for transfer:", err);
        }
      }

      delete pendingTransfers[transferId];
      io.emit("manager:list", findAvailableManagers());

      console.log(`Call transfer completed: ${previousManager} -> ${email} for customer ${customerPhone}`);
    });

    // Target manager rejects transfer
    socket.on("call:transfer-reject", (data) => {
      if (role !== "manager") return;

      const { transferId, reason } = data;
      const transfer = pendingTransfers[transferId];

      if (!transfer) {
        return socket.emit("call:error", { message: "Transfer request not found or expired" });
      }

      // Notify original manager
      io.to(transfer.fromSocketId).emit("call:transfer-rejected", {
        transferId,
        targetManagerEmail: email,
        reason: reason || "Transfer declined",
        message: "Transfer request was declined"
      });

      // Confirm to rejecting manager
      socket.emit("call:transfer-reject-confirmed", {
        transferId,
        message: "Transfer request declined"
      });

      delete pendingTransfers[transferId];
      console.log(`Call transfer rejected by ${email} for transfer ${transferId}`);
    });

    // Get available managers for transfer
    socket.on("call:get-transfer-targets", () => {
      if (role !== "manager") return;

      const availableManagers = findAvailableManagers()
        .filter(m => m.email !== email) // Exclude self
        .map(m => ({
          email: m.email,
          name: m.name,
          status: m.status
        }));

      socket.emit("call:transfer-targets", { managers: availableManagers });
    });

    // ==================== SUPERVISOR EVENTS ====================

    // Supervisor joins a call in listen mode
    socket.on("supervisor:join-call", (data) => {
      const { customerPhone: rawPhone, mode = "listen" } = data; // mode: listen, whisper, barge
      const customerPhone = normalizePhone(rawPhone);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "Call not found" });
      }

      const call = activeCustomerCalls[customerPhone];
      const supervisorId = email || socket.id;

      // Initialize supervisors array if not exists
      if (!call.supervisors) {
        call.supervisors = [];
      }

      // Add supervisor to call
      const supervisorEntry = {
        id: supervisorId,
        socketId: socket.id,
        name: name || email,
        mode: mode,
        joinedAt: Date.now()
      };

      // Remove existing entry if supervisor is rejoining
      call.supervisors = call.supervisors.filter(s => s.id !== supervisorId);
      call.supervisors.push(supervisorEntry);

      // Track in activeSupervisors
      activeSupervisors[socket.id] = {
        supervisorId,
        customerPhone,
        mode
      };
      touchSupervisor(socket.id);
      touchCall(customerPhone);

      // Get manager socket to notify
      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === call.currentManagerEmail
      )?.socketId;

      // Notify manager about supervisor joining
      if (managerSocketId) {
        io.to(managerSocketId).emit("supervisor:joined", {
          supervisorId,
          supervisorName: name || email,
          mode: mode,
          customerPhone,
          timestamp: Date.now()
        });
      }

      // Send call details to supervisor
      socket.emit("supervisor:call-joined", {
        customerPhone,
        managerEmail: call.currentManagerEmail,
        callRoom: call.callRoom,
        mode: mode,
        startTime: call.startTime,
        isOnHold: call.isOnHold || false
      });

      console.log(`👁️ Supervisor ${supervisorId} joined call ${customerPhone} in ${mode} mode`);
    });

    // Supervisor starts whisper mode (audio to manager only)
    socket.on("supervisor:start-whisper", (data) => {
      const { customerPhone } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "Call not found" });
      }

      const call = activeCustomerCalls[customerPhone];
      const supervisorId = email || socket.id;

      // Update supervisor mode
      const supervisor = call.supervisors?.find(s => s.id === supervisorId);
      if (supervisor) {
        supervisor.mode = "whisper";
        supervisor.whisperStartedAt = Date.now();
      }

      // Update activeSupervisors
      if (activeSupervisors[socket.id]) {
        activeSupervisors[socket.id].mode = "whisper";
        touchSupervisor(socket.id);
      }
      touchCall(customerPhone);

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === call.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("supervisor:whisper-started", {
          supervisorId,
          supervisorName: name || email,
          customerPhone,
          timestamp: Date.now()
        });
      }

      socket.emit("supervisor:whisper-active", {
        customerPhone,
        timestamp: Date.now()
      });

      console.log(`🔊 Supervisor ${supervisorId} started whisper mode for call ${customerPhone}`);
    });

    // Supervisor stops whisper mode
    socket.on("supervisor:stop-whisper", (data) => {
      const { customerPhone } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "Call not found" });
      }

      const call = activeCustomerCalls[customerPhone];
      const supervisorId = email || socket.id;

      // Update supervisor mode back to listen
      const supervisor = call.supervisors?.find(s => s.id === supervisorId);
      if (supervisor) {
        supervisor.mode = "listen";
        delete supervisor.whisperStartedAt;
      }

      // Update activeSupervisors
      if (activeSupervisors[socket.id]) {
        activeSupervisors[socket.id].mode = "listen";
        touchSupervisor(socket.id);
      }
      touchCall(customerPhone);

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === call.currentManagerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit("supervisor:whisper-stopped", {
          supervisorId,
          supervisorName: name || email,
          customerPhone,
          timestamp: Date.now()
        });
      }

      socket.emit("supervisor:whisper-inactive", {
        customerPhone,
        timestamp: Date.now()
      });

      console.log(`🔇 Supervisor ${supervisorId} stopped whisper mode for call ${customerPhone}`);
    });

    // Supervisor sends text whisper (private message to manager only)
    socket.on("supervisor:text-whisper", (data) => {
      const { customerPhone: rawPhone, message } = data;
      const customerPhone = normalizePhone(rawPhone);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "Call not found" });
      }

      const call = activeCustomerCalls[customerPhone];
      const supervisorId = email || socket.id;

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === call.currentManagerEmail
      )?.socketId;

      const whisperMessage = {
        id: crypto.randomUUID(),
        senderId: supervisorId,
        senderName: name || email,
        message,
        timestamp: Date.now(),
        type: "whisper"
      };

      if (managerSocketId) {
        io.to(managerSocketId).emit("supervisor:text-whisper", whisperMessage);
      }

      // Confirm to supervisor
      socket.emit("supervisor:text-whisper-sent", whisperMessage);

      console.log(`💬 Supervisor ${supervisorId} sent text whisper to manager for call ${customerPhone}`);
    });

    // Manager responds to text whisper
    socket.on("manager:text-whisper-reply", (data) => {
      if (role !== "manager") return;

      const { supervisorId, message } = data;
      const customerPhone = normalizePhone(socket.user.customerPhone);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "No active call" });
      }

      const call = activeCustomerCalls[customerPhone];
      const supervisor = call.supervisors?.find(s => s.id === supervisorId);

      if (!supervisor) {
        return socket.emit("call:error", { message: "Supervisor not found in call" });
      }

      const whisperReply = {
        id: crypto.randomUUID(),
        senderId: email,
        senderName: name || email,
        message,
        timestamp: Date.now(),
        type: "whisper-reply"
      };

      io.to(supervisor.socketId).emit("manager:text-whisper-reply", whisperReply);

      // Confirm to manager
      socket.emit("manager:text-whisper-reply-sent", whisperReply);

      console.log(`💬 Manager ${email} replied to supervisor ${supervisorId} whisper`);
    });

    // Supervisor barge-in (join call, speak to both)
    socket.on("supervisor:barge-in", (data) => {
      const { customerPhone } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "Call not found" });
      }

      const call = activeCustomerCalls[customerPhone];
      const supervisorId = email || socket.id;

      // Update supervisor mode
      const supervisor = call.supervisors?.find(s => s.id === supervisorId);
      if (supervisor) {
        supervisor.mode = "barge";
        supervisor.bargeStartedAt = Date.now();
      }

      // Update activeSupervisors
      if (activeSupervisors[socket.id]) {
        activeSupervisors[socket.id].mode = "barge";
        touchSupervisor(socket.id);
      }
      touchCall(customerPhone);

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === call.currentManagerEmail
      )?.socketId;

      // Notify manager
      if (managerSocketId) {
        io.to(managerSocketId).emit("supervisor:barged-in", {
          supervisorId,
          supervisorName: name || email,
          customerPhone,
          callRoom: call.callRoom,
          timestamp: Date.now()
        });
      }

      // Notify customer
      io.to(call.customerSocketId).emit("supervisor:barged-in", {
        supervisorName: name || "Supervisor",
        timestamp: Date.now()
      });

      // Send call room to supervisor for joining
      socket.emit("supervisor:barge-active", {
        customerPhone,
        callRoom: call.callRoom,
        timestamp: Date.now()
      });

      console.log(`📢 Supervisor ${supervisorId} barged into call ${customerPhone}`);
    });

    // Supervisor takes over call from manager
    socket.on("supervisor:takeover-call", (data) => {
      const { customerPhone } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "Call not found" });
      }

      const call = activeCustomerCalls[customerPhone];
      const supervisorId = email || socket.id;
      const previousManager = call.currentManagerEmail;

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === previousManager
      )?.socketId;

      // Notify previous manager about takeover
      if (managerSocketId) {
        io.to(managerSocketId).emit("supervisor:call-takeover", {
          supervisorId,
          supervisorName: name || email,
          customerPhone,
          timestamp: Date.now(),
          message: "Supervisor has taken over this call"
        });

        // Reset previous manager status
        updateUserStatus(previousManager, "manager", AGENT_STATUS.ONLINE);
      }

      // Update call to supervisor
      call.previousManager = previousManager;
      call.currentManagerEmail = supervisorId;
      call.takenOverAt = Date.now();
      call.takenOverBy = supervisorId;
      touchCall(customerPhone);

      // Notify customer
      io.to(call.customerSocketId).emit("call:manager-changed", {
        newManagerName: name || "Supervisor",
        previousManagerName: previousManager,
        timestamp: Date.now()
      });

      // Confirm to supervisor
      socket.emit("supervisor:takeover-complete", {
        customerPhone,
        callRoom: call.callRoom,
        previousManager,
        timestamp: Date.now()
      });

      io.emit("manager:list", findAvailableManagers());

      console.log(`🔄 Supervisor ${supervisorId} took over call ${customerPhone} from manager ${previousManager}`);
    });

    // Supervisor leaves call
    socket.on("supervisor:leave-call", (data) => {
      const { customerPhone } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return socket.emit("call:error", { message: "Call not found" });
      }

      const call = activeCustomerCalls[customerPhone];
      const supervisorId = email || socket.id;

      // Remove supervisor from call
      if (call.supervisors) {
        call.supervisors = call.supervisors.filter(s => s.id !== supervisorId);
        touchCall(customerPhone);
      }

      // Remove from activeSupervisors
      removeSupervisor(socket.id);

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === call.currentManagerEmail
      )?.socketId;

      // Notify manager
      if (managerSocketId) {
        io.to(managerSocketId).emit("supervisor:left", {
          supervisorId,
          supervisorName: name || email,
          customerPhone,
          timestamp: Date.now()
        });
      }

      socket.emit("supervisor:call-left", {
        customerPhone,
        timestamp: Date.now()
      });

      console.log(`👋 Supervisor ${supervisorId} left call ${customerPhone}`);
    });
    // ============ END SUPERVISOR MONITORING EVENTS ============

    // ============ RECORDING EVENTS ============
    // recording:start, recording:stop, recording:status are all handled above
    // (merged into role-dispatched authoritative handlers)
    // ============ END RECORDING EVENTS ============

    // Note: the live hold flow is "call:hold"/"call:resume" above (~line 925),
    // which updates the same activeCustomerCalls[...].isOnHold state and
    // notifies customer/supervisor via "call:hold-started"/"call:hold-ended".
    // The legacy "manager:hold-call"/"manager:resume-call" pair (emitting
    // "call:on-hold"/"call:resumed") had no caller left in the Manager UI and
    // was removed.

    // ============ SCREEN SYNC EVENTS ============
    socket.on("manager:screen-sync", (data) => {
      if (role !== "manager") return;

      const customerPhone = socket.user.customerPhone;
      const { screen, accountData } = data;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        return;
      }

      console.log(`🖥️ Manager ${email} syncing screen to "${screen}" for customer ${customerPhone}`);
      if (accountData) {
        console.log(`   📋 Account data: ${accountData.accountNumber} | Email: ${accountData.email}`);
      }

      // Send screen sync to customer with account data
      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "customer:screen-sync",
        {
          screen: screen,
          managerEmail: email,
          managerName: name,
          accountData: accountData || null,
          timestamp: Date.now()
        }
      );
    });
    // ============ END SCREEN SYNC EVENTS ============

    socket.on("manager:request-face-verification", (data) => {
      if (role !== "manager") return;

      const customerPhone = socket.user.customerPhone;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      // Clear any previous requests first
      clearCustomerRequests(activeCustomerCalls[customerPhone].customerSocketId);

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "customer:face-verification-request",
        {
          requestId: crypto.randomUUID(),
          managerId: email,
        }
      );

      console.log(
        `📣 Face verification request sent to customer ${customerPhone}`
      );
    });

    socket.on("manager:request-retake-image", async (data) => {
      if (role !== "manager") return;

      const customerPhone = socket.user.customerPhone;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      const customerSocketId = activeCustomerCalls[customerPhone].customerSocketId;

      // Clear any existing timeout
      if (activeCustomerCalls[customerPhone].faceVerificationTimeout) {
        clearTimeout(activeCustomerCalls[customerPhone].faceVerificationTimeout);
        delete activeCustomerCalls[customerPhone].faceVerificationTimeout;
        touchCall(customerPhone);
      }

      // Check if customer is still connected (cluster-aware, via Redis adapter)
      const customerSockets = await io.in(customerSocketId).fetchSockets();
      if (customerSockets.length === 0) {
        return socket.emit("call:error", {
          message: "Customer has disconnected",
        });
      }

      io.to(customerSocketId).emit(
        "manager:request-retake-image",
        {
          requestId: crypto.randomUUID(),
          managerId: email,
          managerName: name || null,
          timestamp: Date.now()
        }
      );

      console.log(`🔄 Retake request sent to customer ${customerPhone}`);
    });

    socket.on("manager:request-capture-image", (data) => {
      if (role !== "manager") return;

      const customerPhone = socket.user.customerPhone;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      console.log(`📸 Manager ${email} requesting face capture from customer ${customerPhone}`);
      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "customer:capture-image-request",
        {
          requestId: crypto.randomUUID(),
          managerId: email,
        }
      );
      console.log(`📤 Sent capture-image-request to customer socket: ${activeCustomerCalls[customerPhone].customerSocketId}`);
    });

    socket.on('manager:request-submit-image', (data) => {
      if (role !== "manager") return;

      const customerPhone = socket.user.customerPhone;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", {
          message: "No active call with customer",
        });
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "customer:submit-image-request",
        {
          requestId: crypto.randomUUID(),
          managerId: email,
        }
      );
    });


    socket.on("customer:send-captured-image", async (data) => {
      if (role !== "customer") return;

      const { imagePath, imageBase64 } = data;
      const normalizedPhone = normalizePhone(phone);
      console.log(`📷 Customer ${normalizedPhone} sent captured image:`, imagePath ? 'path provided' : 'no path', imageBase64 ? 'base64 provided' : 'no base64');

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        socket.emit("customer:capture-error", {
          message: "No active call found. Please reconnect.",
          error: "no_active_call"
        });
        return;
      }

      // Clear timeout since we received the image
      if (activeCall.faceVerificationTimeout) {
        clearTimeout(activeCall.faceVerificationTimeout);
        delete activeCall.faceVerificationTimeout;
        touchCall(normalizedPhone);
        console.log(`✅ Cleared face verification timeout for customer ${normalizedPhone}`);
      }

      const managerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.email === activeCall.currentManagerEmail
      )?.socketId;

      console.log(`🔍 Manager for customer ${normalizedPhone}: ${activeCall.currentManagerEmail}, socketId: ${managerSocketId || 'NOT FOUND'}`);

      // Send image to manager for display
      if (managerSocketId) {
        console.log(`📤 Emitting manager:received-image-link to manager socket ${managerSocketId}`);
        io.to(managerSocketId).emit("manager:received-image-link", {
          customerId: phone,
          imagePath: imagePath,
          timestamp: Date.now(),
          verificationPending: true
        });
        console.log(`✅ Image link sent to manager`);
      } else {
        console.log(`❌ Manager socket not found, cannot send image`);
        socket.emit("customer:capture-error", {
          message: "Manager disconnected. Please wait for reconnection.",
          error: "manager_disconnected"
        });
      }

      // Verify face via CBS getUserIdentity API
      try {
        console.log(`🔍 Starting CBS face verification for customer ${normalizedPhone}`);
        const accountNumber = activeCall.accountNumber || null;

        const verificationResult = await faceVerificationService.verifyFaceViaCBS(
          accountNumber,
          imageBase64 || imagePath
        );

        console.log(`📊 Face verification result for ${normalizedPhone}:`, verificationResult);

        // Update active call with verification result
        if (verificationResult.verified) {
          activeCustomerCalls[normalizedPhone].faceVerified = true;
          activeCustomerCalls[normalizedPhone].faceMatchScore = verificationResult.score;
          touchCall(normalizedPhone);

          // Update call log
          if (activeCall.callRoom) {
            try {
              await callLogService.updateVerificationStatus(activeCall.callRoom, "face", true);
            } catch (err) {
              console.error("❌ Error updating call log face verification:", err);
            }
          }
        }

        // Send verification result to manager
        if (managerSocketId) {
          io.to(managerSocketId).emit("manager:face-verification-result", {
            customerId: phone,
            verified: verificationResult.verified,
            score: verificationResult.score,
            confidence: verificationResult.confidence,
            message: verificationResult.message,
            timestamp: Date.now()
          });
        }

        // Send verification result to customer
        socket.emit("customer:face-verification-result", {
          verified: verificationResult.verified,
          score: verificationResult.score,
          message: verificationResult.verified
            ? "Face verification successful"
            : "Face verification failed - please try again",
          timestamp: Date.now()
        });

      } catch (error) {
        console.error(`❌ Face verification error for ${normalizedPhone}:`, error);

        // Notify manager of error
        if (managerSocketId) {
          io.to(managerSocketId).emit("manager:face-verification-result", {
            customerId: phone,
            verified: false,
            error: true,
            message: "Face verification failed: " + error.message,
            timestamp: Date.now()
          });
        }

        // Notify customer of error
        socket.emit("customer:face-verification-result", {
          verified: false,
          error: true,
          message: "Face verification failed. Please try again.",
          timestamp: Date.now()
        });
      }
    });

    socket.on("manager:verify-image", async (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", { message: "No active call with customer" });
      }

      const { verificationStatus } = data;
      const isVerified = verificationStatus === "verified";

      // Track face verification in active call
      if (isVerified) {
        activeCustomerCalls[customerPhone].faceVerified = true;
        touchCall(customerPhone);

        // Update call log
        if (activeCustomerCalls[customerPhone].callRoom) {
          try {
            await callLogService.updateVerificationStatus(activeCustomerCalls[customerPhone].callRoom, "face", true);
          } catch (err) {
            console.error("❌ Error updating call log face verification:", err);
          }
        }
      }

      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("customer:image-verified", {
        status: verificationStatus || "verified",
        managerId: email,
        managerName: name || null,
        timestamp: Date.now()
      });

      console.log(`📣 Image verification (${verificationStatus}) sent to customer ${customerPhone}`);
    });

    // Manager final decision on face verification (with AI override capability)
    socket.on("manager:face-verification-decision", async (data) => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("call:error", { message: "No active call with customer" });
      }

      const { decision, aiRecommendation, similarity, confidence, managerOverride } = data;
      const isAccepted = decision === 'accepted';

      // Log manager decision with full context
      console.log(
        `🎯 Manager ${email} face verification decision for ${customerPhone}:`,
        `Decision: ${decision.toUpperCase()}`,
        `| AI: ${aiRecommendation}`,
        `| Similarity: ${similarity}%`,
        `| Confidence: ${confidence}%`,
        managerOverride ? `| ⚠️ MANAGER OVERRIDE` : ''
      );

      // Track face verification in active call
      if (isAccepted) {
        activeCustomerCalls[customerPhone].faceVerified = true;
        activeCustomerCalls[customerPhone].faceVerificationOverride = managerOverride || false;
        activeCustomerCalls[customerPhone].faceVerificationSimilarity = similarity;
        touchCall(customerPhone);

        // Update call log with verification decision
        if (activeCustomerCalls[customerPhone].callRoom) {
          try {
            await callLogService.updateVerificationStatus(
              activeCustomerCalls[customerPhone].callRoom,
              "face",
              true,
              {
                aiRecommendation,
                similarity,
                confidence,
                managerOverride,
                managerEmail: email,
                decisionTimestamp: Date.now()
              }
            );
            console.log(`✅ Call log updated with face verification acceptance`);
          } catch (err) {
            console.error("❌ Error updating call log face verification:", err);
          }
        }
      } else {
        // Manager rejected - store rejection details
        activeCustomerCalls[customerPhone].faceVerified = false;
        activeCustomerCalls[customerPhone].faceVerificationRejected = true;
        activeCustomerCalls[customerPhone].faceVerificationOverride = managerOverride || false;
        touchCall(customerPhone);

        if (activeCustomerCalls[customerPhone].callRoom) {
          try {
            await callLogService.updateVerificationStatus(
              activeCustomerCalls[customerPhone].callRoom,
              "face",
              false,
              {
                aiRecommendation,
                similarity,
                confidence,
                managerOverride,
                managerEmail: email,
                rejected: true,
                decisionTimestamp: Date.now()
              }
            );
            console.log(`⛔ Call log updated with face verification rejection`);
          } catch (err) {
            console.error("❌ Error updating call log face verification:", err);
          }
        }
      }

      // Notify customer of manager's decision
      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("customer:face-verification-result", {
        verified: isAccepted,
        decision: decision,
        aiRecommendation: aiRecommendation,
        managerOverride: managerOverride,
        managerId: email,
        managerName: name || null,
        timestamp: Date.now()
      });

      // Confirm to manager
      socket.emit("manager:face-verification-decision-confirmed", {
        customerPhone,
        decision,
        recorded: true,
        timestamp: Date.now()
      });

      console.log(`📣 Face verification decision (${decision}) sent to customer ${customerPhone}`);
    });

    // ============ CHAT EVENTS ============
    socket.on("chat:send", async (data) => {
      const { message, timestamp } = data;
      const messageId = crypto.randomUUID();

      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);
        const managerActiveCall = customerPhone ? await ensureLocalActiveCall(io, customerPhone) : null;

        if (!managerActiveCall) {
          console.log(`⚠️ No active call found for chat message from manager ${email}`);
          return socket.emit("call:error", { message: "No active call with customer" });
        }

        // Increment chat message count
        activeCustomerCalls[customerPhone].chatMessagesCount =
          (activeCustomerCalls[customerPhone].chatMessagesCount || 0) + 1;
        touchCall(customerPhone);

        const chatMessage = {
          id: messageId,
          senderId: email,
          senderName: name || "Manager",
          senderRole: "manager",
          message,
          timestamp: timestamp || Date.now()
        };

        // Send to customer
        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("chat:receive", chatMessage);

        // Confirm to manager
        socket.emit("chat:sent", chatMessage);

        console.log(`💬 Chat message from Manager ${email} to Customer ${customerPhone}: ${message.substring(0, 50)}...`);

      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = await ensureLocalActiveCall(io, normalizedPhone);

        if (!activeCall || !activeCall.currentManagerEmail) {
          console.log(`⚠️ No active call found for chat message from customer ${normalizedPhone}`);
          return socket.emit("call:error", { message: "No active call with manager" });
        }

        // Increment chat message count
        activeCustomerCalls[normalizedPhone].chatMessagesCount =
          (activeCustomerCalls[normalizedPhone].chatMessagesCount || 0) + 1;
        touchCall(normalizedPhone);

        const managerSocketId = activeCall.managerSocketId || getOnlineUsersWithInfo().find(
          (user) => user.email === activeCall.currentManagerEmail
        )?.socketId;

        const chatMessage = {
          id: messageId,
          senderId: phone,
          senderName: name || phone,
          senderRole: "customer",
          message,
          timestamp: timestamp || Date.now()
        };

        if (managerSocketId) {
          // Send to manager
          io.to(managerSocketId).emit("chat:receive", chatMessage);

          // Confirm to customer
          socket.emit("chat:sent", chatMessage);

          console.log(`💬 Chat message from Customer ${phone} to Manager ${activeCall.currentManagerEmail}: ${message.substring(0, 50)}...`);
        } else {
          // Manager's socket couldn't be resolved (stale registry entry, manager
          // reconnected under a new socket id, etc.) — surface this instead of
          // silently dropping the message, so the customer knows to retry.
          console.log(`⚠️ Could not resolve socket for Manager ${activeCall.currentManagerEmail} — chat message from ${phone} not delivered`);
          socket.emit("chat:error", { message: "Unable to deliver message to manager. Please try again.", messageId });
        }
      }
    });

    socket.on("chat:typing", async (data) => {
      const { isTyping } = data;

      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);
        const managerActiveCall = customerPhone ? await ensureLocalActiveCall(io, customerPhone) : null;

        if (!managerActiveCall) return;

        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("chat:typing", {
          senderId: email,
          senderRole: "manager",
          isTyping
        });

      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = await ensureLocalActiveCall(io, normalizedPhone);

        if (!activeCall || !activeCall.currentManagerEmail) return;

        const managerSocketId = getOnlineUsersWithInfo().find(
          (user) => user.email === activeCall.currentManagerEmail
        )?.socketId;

        if (managerSocketId) {
          io.to(managerSocketId).emit("chat:typing", {
            senderId: phone,
            senderRole: "customer",
            isTyping
          });
        }
      }
    });
    // ============ END CHAT EVENTS ============

    // ============ WHITEBOARD EVENTS ============
    // Bidirectional relay: stroke, clear, undo, toggle

    socket.on("whiteboard:stroke", async (data) => {
      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);
        const managerActiveCall = customerPhone ? await ensureLocalActiveCall(io, customerPhone) : null;
        if (!managerActiveCall) return;
        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("whiteboard:stroke", {
          ...data,
          senderId: email,
          senderRole: "manager",
        });
      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = await ensureLocalActiveCall(io, normalizedPhone);
        if (!activeCall || !activeCall.managerSocketId) return;
        io.to(activeCall.managerSocketId).emit("whiteboard:stroke", {
          ...data,
          senderId: phone,
          senderRole: "customer",
        });
      }
    });

    socket.on("whiteboard:clear", async (data) => {
      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);
        const managerActiveCall = customerPhone ? await ensureLocalActiveCall(io, customerPhone) : null;
        if (!managerActiveCall) return;
        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("whiteboard:clear", {
          senderId: email,
          senderRole: "manager",
          timestamp: Date.now(),
        });
      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = await ensureLocalActiveCall(io, normalizedPhone);
        if (!activeCall || !activeCall.managerSocketId) return;
        io.to(activeCall.managerSocketId).emit("whiteboard:clear", {
          senderId: phone,
          senderRole: "customer",
          timestamp: Date.now(),
        });
      }
    });

    socket.on("whiteboard:undo", async (data) => {
      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);
        const managerActiveCall = customerPhone ? await ensureLocalActiveCall(io, customerPhone) : null;
        if (!managerActiveCall) return;
        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("whiteboard:undo", {
          senderId: email,
          senderRole: "manager",
          timestamp: Date.now(),
        });
      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = await ensureLocalActiveCall(io, normalizedPhone);
        if (!activeCall || !activeCall.managerSocketId) return;
        io.to(activeCall.managerSocketId).emit("whiteboard:undo", {
          senderId: phone,
          senderRole: "customer",
          timestamp: Date.now(),
        });
      }
    });

    socket.on("whiteboard:toggle", async (data) => {
      const { open } = data;
      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);
        const managerActiveCall = customerPhone ? await ensureLocalActiveCall(io, customerPhone) : null;
        if (!managerActiveCall) return;
        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("whiteboard:toggle", {
          open,
          senderId: email,
          senderRole: "manager",
        });
      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = await ensureLocalActiveCall(io, normalizedPhone);
        if (!activeCall || !activeCall.managerSocketId) return;
        io.to(activeCall.managerSocketId).emit("whiteboard:toggle", {
          open,
          senderId: phone,
          senderRole: "customer",
        });
      }
    });

    // ============ END WHITEBOARD EVENTS ============

    // ============ CHANGE REQUEST EVENTS ============
    // manager:approve-change, manager:reject-change, manager:approve-address-change,
    // manager:reject-address-change are all handled above (merged into authoritative handlers)
    // ============ END CHANGE REQUEST EVENTS ============

    socket.on("disconnect", async () => {
      // Handle admin/supervisor disconnect
      if (isAdmin || role === 'admin' || role === 'supervisor') {
        console.log(`❌ Admin/Supervisor disconnected: ${socketId} | Role: ${role} | Email: ${email}`);
        removeSupervisor(socketId);
        return;
      }

      console.log(
        `❌ User disconnected: ${socketId} | Role: ${role}` +
        (phone ? ` | Phone: ${phone}` : "") +
        (email ? ` | Email: ${email}` : "")
      );

      if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);

        // Remove from queue if waiting (not in an active call)
        const wasInQueue = await removeCustomerFromQueue(phone);
        if (wasInQueue) {
          console.log(`📋 Customer ${phone} removed from queue on disconnect`);
          broadcastQueueAndStatus(io);
        }

        // If in an active call, start grace period instead of ending immediately
        const activeCall = activeCustomerCalls[normalizedPhone];
        if (activeCall && activeCall.currentManagerEmail && !activeCall.callEndingByCustomer) {
          // Stop recording immediately — WebRTC data won't come in anyway
          if (activeCall.egressId) {
            try {
              const recordingService = require('./recordingService');
              await recordingService.stopRecording(activeCall.egressId);
              console.log(`🛑 Auto-recording stopped on customer disconnect for ${normalizedPhone}`);
            } catch (recErr) {
              console.error("⚠️ Failed to auto-stop recording on customer disconnect:", recErr.message);
            }
          }

          // Notify manager and start grace period
          const managerSocketId = activeCall.managerSocketId;
          if (managerSocketId) {
            io.to(managerSocketId).emit("customer:reconnecting", {
              message: "Customer connection interrupted. Waiting for reconnect...",
              gracePeriodMs: DISCONNECT_GRACE_MS,
            });
          }

          console.log(`⏳ Customer ${normalizedPhone} disconnected during call — ${DISCONNECT_GRACE_MS / 1000}s grace period started`);
          disconnectTimers[normalizedPhone] = setTimeout(async () => {
            delete disconnectTimers[normalizedPhone];
            if (!activeCustomerCalls[normalizedPhone]) return; // Already cleaned up

            console.log(`⌛ Grace period expired for customer ${normalizedPhone} — ending call`);
            const callEntry = activeCustomerCalls[normalizedPhone];

            // Complete call log so it registers as a taken/completed call
            if (callEntry?.callRoom) {
              try {
                await callLogService.completeCall(callEntry.callRoom, "system", {
                  phoneVerified: callEntry.phoneVerified || false,
                  emailVerified: callEntry.emailVerified || false,
                  faceVerified: callEntry.faceVerified || false,
                  chatMessagesCount: callEntry.chatMessagesCount || 0,
                  metadata: { disconnectedBy: "customer" },
                });
              } catch (err) {
                console.error("❌ Error completing call log on customer disconnect timeout:", err);
              }
            }

            const mgrSockets = await io.in(callEntry.managerSocketId).fetchSockets();
            if (mgrSockets.length > 0) {
              io.to(callEntry.managerSocketId).emit("call:ended", {
                endedBy: "system",
                reason: "customer_disconnected",
                message: "Call ended: customer did not reconnect in time.",
                callLogId: callEntry.callLogId || null,
                referenceNumber: callEntry.referenceNumber || null,
              });
            }
            const custSocketId = callEntry?.customerSocketId;
            if (custSocketId) {
              io.to(custSocketId).emit("call:ended", {
                endedBy: "system",
                reason: "customer_disconnected",
              });
            }
            await clearActiveCustomerCall(normalizedPhone, io);
            io.emit("manager:list", findAvailableManagers());
            io.emit("stats:update", { event: "call-completed", timestamp: Date.now() });
            await broadcastQueueAndStatus(io);
          }, DISCONNECT_GRACE_MS);
        } else {
          // Not in an active call — clear immediately as before
          await clearActiveCustomerCall(phone, io);
        }
      } else if (role === "manager") {
        Object.keys(activeCustomerCalls).forEach((customerPhone) => {
          const normalizedCustPhone = normalizePhone(customerPhone);
          if (activeCustomerCalls[normalizedCustPhone].currentManagerEmail === email) {
            const timerKey = `mgr:${email}:${normalizedCustPhone}`;
            const custSocketId = activeCustomerCalls[normalizedCustPhone].customerSocketId;

            // Notify customer and start grace period
            if (custSocketId) {
              io.to(custSocketId).emit("manager:reconnecting", {
                message: "Manager connection interrupted. Waiting for reconnect...",
                gracePeriodMs: DISCONNECT_GRACE_MS,
              });
            }

            console.log(`⏳ Manager ${email} disconnected during call with ${normalizedCustPhone} — ${DISCONNECT_GRACE_MS / 1000}s grace period started`);
            disconnectTimers[timerKey] = setTimeout(async () => {
              delete disconnectTimers[timerKey];
              if (!activeCustomerCalls[normalizedCustPhone] ||
                  activeCustomerCalls[normalizedCustPhone].currentManagerEmail !== email) return;

              console.log(`⌛ Grace period expired for manager ${email} — ending call with ${normalizedCustPhone}`);
              const callEntry = activeCustomerCalls[normalizedCustPhone];

              // Complete call log so it registers as a taken/completed call
              if (callEntry?.callRoom) {
                try {
                  await callLogService.completeCall(callEntry.callRoom, "system", {
                    phoneVerified: callEntry.phoneVerified || false,
                    emailVerified: callEntry.emailVerified || false,
                    faceVerified: callEntry.faceVerified || false,
                    chatMessagesCount: callEntry.chatMessagesCount || 0,
                    metadata: { disconnectedBy: "manager" },
                  });
                } catch (err) {
                  console.error("❌ Error completing call log on manager disconnect timeout:", err);
                }
              }

              const cSockets = await io.in(callEntry.customerSocketId).fetchSockets();
              if (cSockets.length > 0) {
                io.to(callEntry.customerSocketId).emit("call:ended", {
                  endedBy: "system",
                  reason: "manager_disconnected",
                  message: "Call ended: manager did not reconnect in time.",
                });
              }
              await clearActiveCustomerCall(normalizedCustPhone, io);
              io.emit("manager:list", findAvailableManagers());
              io.emit("stats:update", { event: "call-completed", timestamp: Date.now() });
              await broadcastQueueAndStatus(io);
            }, DISCONNECT_GRACE_MS);
          }
        });
      }
      removeUserInCache(socketId);
      io.emit("manager:list", findAvailableManagers());
    });

    socket.on("error", (error) => {
      console.error(`❌ Socket error: ${socketId} - ${error.message}`);
    });
  } catch (error) {
    socket.emit("call:error", { message: error.message });
    socket.disconnect(true);
  }
};

/**
 * Select top managers for broadcast routing
 * Uses intelligent load balancing based on call history
 * @param {Array} availableManagers - List of available managers
 * @param {number} maxManagers - Maximum number of managers to select (default 3)
 * @returns {Array} Selected managers for broadcast
 */
const selectManagersForBroadcast = (availableManagers, maxManagers = 3) => {
  if (availableManagers.length === 0) return [];
  if (availableManagers.length <= maxManagers) return availableManagers;

  // Get call history for load balancing
  const managerStats = availableManagers.map(manager => {
    // Count active calls this manager has handled
    let activeCalls = 0;
    for (const [phone, call] of Object.entries(activeCustomerCalls)) {
      if (call.currentManagerEmail === manager.email || call.acceptedManager === manager.email) {
        activeCalls++;
      }
    }

    // Calculate idle time (time since last call)
    const allManagers = getAllManagers();
    const managerInfo = allManagers.find(m => m.email === manager.email);
    const idleTime = managerInfo?.statusChangedAt
      ? Date.now() - new Date(managerInfo.statusChangedAt).getTime()
      : Date.now();

    return {
      manager,
      activeCalls,
      idleTime,
      // Lower score = higher priority
      score: activeCalls * 1000000 - idleTime // Prioritize fewer calls, then longer idle
    };
  });

  // Sort by score (lower is better) and select top N
  managerStats.sort((a, b) => a.score - b.score);

  const selected = managerStats.slice(0, maxManagers).map(stat => stat.manager);

  console.log(
    `🎯 Selected ${selected.length} managers based on load balancing:`,
    selected.map((m, i) => `${i + 1}. ${m.email} (active: ${managerStats[i].activeCalls})`).join(', ')
  );

  return selected;
};

const attemptCallToNextManager = async (socket, customerPhone, managerQueue, io) => {
  const normalizedCustomerPhone = normalizePhone(customerPhone);
  console.log(
    `🔄 Attempting to find next manager for customer ${normalizedCustomerPhone}`
  );
  console.log(`📋 Manager queue length: ${managerQueue.length}`);

  if (!socket || !customerPhone || !activeCustomerCalls[normalizedCustomerPhone]) {
    console.log(`⚠️ Invalid call attempt state for customer ${normalizedCustomerPhone}`);
    return;
  }

  if (managerQueue.length === 0) {
    console.log(`📋 No more managers available for customer ${normalizedCustomerPhone}, adding to BullMQ queue`);

    // Add customer to BullMQ queue instead of failing
    const result = await addCustomerToQueue({
      customerPhone: normalizedCustomerPhone,
      socketId: activeCustomerCalls[normalizedCustomerPhone]?.customerSocketId,
      customerName: activeCustomerCalls[normalizedCustomerPhone]?.customerName,
      customerEmail: activeCustomerCalls[normalizedCustomerPhone]?.customerEmail,
      priority: 'NORMAL'
    });

    if (result.success) {
      socket.emit("queue:added", {
        position: result.queuePosition,
        message: "All managers are currently busy. You have been added to the queue.",
        jobId: result.jobId
      });

      // Broadcast queue update
      await broadcastQueueAndStatus(io);

      console.log(`✅ Customer ${customerPhone} added to BullMQ queue at position ${result.queuePosition}`);
    } else if (result.alreadyInQueue) {
      // Already in queue
      socket.emit("queue:already", {
        position: result.queuePosition,
        message: "You are already in the queue"
      });
    } else {
      // Failed to add to queue
      socket.emit("call:failed", {
        message: "Failed to add to queue. Please try again."
      });
    }

    await clearActiveCustomerCall(customerPhone, io);
    return;
  }

  const selectedManager = managerQueue.shift();
  console.log(
    `🔄 Selected manager ${selectedManager.email} for customer ${customerPhone}`
  );

  if (
    activeCustomerCalls[normalizedCustomerPhone].attemptedManagers.has(
      selectedManager.email
    )
  ) {
    console.log(
      `⚠️ Manager ${selectedManager.email} was already attempted or rejected, trying next`
    );
    return attemptCallToNextManager(socket, normalizedCustomerPhone, managerQueue, io);
  }

  activeCustomerCalls[normalizedCustomerPhone].attemptedManagers.add(
    selectedManager.email
  );
  activeCustomerCalls[normalizedCustomerPhone].currentManagerEmail =
    selectedManager.email;
  activeCustomerCalls[normalizedCustomerPhone].managerSocketId =
    selectedManager.socketId;
  touchCall(normalizedCustomerPhone);

  const roomId = crypto
    .createHash("sha256")
    .update(`${normalizedCustomerPhone}_${selectedManager.email}_${Date.now()}`)
    .digest("hex")
    .slice(0, 16);
  const callRoomLink = `https://${OPENVIDU_DOMAIN}/${roomId}`;

  // Store room ID for OpenVidu/LiveKit (just the ID, not full URL)
  activeCustomerCalls[normalizedCustomerPhone].callRoom = roomId;
  activeCustomerCalls[normalizedCustomerPhone].callRoomLink = callRoomLink;
  touchCall(normalizedCustomerPhone);

  const managerSocket = io.sockets.sockets.get(selectedManager.socketId);
  if (managerSocket) {
    managerSocket.user.customerPhone = normalizedCustomerPhone;
  }

  // Fetch customer info from CBS
  const cbsService = require("./cbsService");
  let customerInfo = {};
  try {
    const cbsData = await cbsService.lookupCustomerByPhone(normalizedCustomerPhone);
    if (cbsData.found) {
      customerInfo = {
        customerName: cbsData.name,
        customerEmail: cbsData.email,
        customerImage: cbsData.profileImage,
      };
    }
  } catch (error) {
    console.error(`Error fetching customer info for ${normalizedCustomerPhone}:`, error);
  }

  io.to(selectedManager.socketId).emit("call:request", {
    customerId: normalizedCustomerPhone,
    customerSocketId: activeCustomerCalls[normalizedCustomerPhone].customerSocketId,
    callRoom: roomId,
    customerPhone: normalizedCustomerPhone,
    ...customerInfo,
  });

  // Notify customer that call is being connected
  io.to(activeCustomerCalls[normalizedCustomerPhone].customerSocketId).emit(
    "call:initiated",
    {
      managerId: selectedManager.email,
      managerName: selectedManager.name || null,
      ...(selectedManager.image && { managerImage: selectedManager.image }),
      callRoom: roomId,
    }
  );

  console.log(
    `📞 Call initiated: Customer ${normalizedCustomerPhone} → Manager ${selectedManager.email}`
  );
  console.log(`🔗 Call Room: ${roomId}`);

  // Capture previous status BEFORE setting to busy so it can be restored on call end
  if (!activeCustomerCalls[normalizedCustomerPhone].managerPreviousStatus) {
    const allMgrs = getAllManagers();
    const mgr = allMgrs.find(m => m.email === selectedManager.email);
    activeCustomerCalls[normalizedCustomerPhone].managerPreviousStatus = mgr?.status || AGENT_STATUS.ONLINE;
    touchCall(normalizedCustomerPhone);
  }

  // Update manager status
  updateUserStatus(selectedManager.email, "manager", "busy");
  io.emit("manager:list", findAvailableManagers());

  // Clear any existing timeout
  if (activeCustomerCalls[normalizedCustomerPhone].timeout) {
    clearTimeout(activeCustomerCalls[normalizedCustomerPhone].timeout);
  }

  // Set timeout for manager response
  activeCustomerCalls[normalizedCustomerPhone].timeout = setTimeout(async () => {
    console.log(
      `⏳ Manager ${selectedManager.email} did not respond in time to customer ${normalizedCustomerPhone}`
    );

    if (
      !activeCustomerCalls[normalizedCustomerPhone] ||
      !activeCustomerCalls[normalizedCustomerPhone].inProgress
    ) {
      console.log(
        `⚠️ Call no longer active for customer ${normalizedCustomerPhone} - timeout handler`
      );
      return;
    }

    if (
      activeCustomerCalls[normalizedCustomerPhone].currentManagerEmail !==
      selectedManager.email
    ) {
      console.log(
        `⚠️ Manager changed during timeout for customer ${normalizedCustomerPhone}`
      );
      return;
    }

    const managerSockets = await io.in(selectedManager.socketId).fetchSockets();
    if (managerSockets.length > 0) {
      io.to(selectedManager.socketId).emit("call:reassigned", {
        message: "Call has been reassigned due to response timeout",
        customerId: normalizedCustomerPhone,
      });
      console.log(
        `📣 Notified manager ${selectedManager.email} about timeout reassignment`
      );
    }

    updateUserStatus(selectedManager.email, "manager", "online");
    io.emit("manager:list", findAvailableManagers());

    let availableManagers = findAvailableManagers().filter(
      (mgr) =>
        !activeCustomerCalls[normalizedCustomerPhone].attemptedManagers.has(mgr.email)
    );

    if (availableManagers.length > 0) {
      console.log(
        `🔄 Attempting next manager after timeout for customer ${normalizedCustomerPhone}`
      );
      attemptCallToNextManager(
        socket,
        normalizedCustomerPhone,
        [...availableManagers],
        io
      );
    } else {
      // All managers tried but none responded - add to BullMQ queue
      console.log(
        `📋 All managers tried but none responded for customer ${normalizedCustomerPhone}, adding to BullMQ queue`
      );

      const addToQueueResult = await addCustomerToQueue({
        customerPhone: normalizedCustomerPhone,
        socketId: activeCustomerCalls[normalizedCustomerPhone]?.customerSocketId,
        customerName: activeCustomerCalls[normalizedCustomerPhone]?.customerName,
        customerEmail: activeCustomerCalls[normalizedCustomerPhone]?.customerEmail,
        priority: 'HIGH' // High priority since they already tried all managers
      });

      if (addToQueueResult.success) {
        socket.emit("queue:added", {
          position: addToQueueResult.queuePosition,
          message: "All managers are currently unavailable. You have been added to the priority queue.",
          jobId: addToQueueResult.jobId,
          priority: 'HIGH'
        });

        await broadcastQueueAndStatus(io);
        console.log(`✅ Customer ${customerPhone} added to priority queue at position ${addToQueueResult.queuePosition}`);
      } else {
        // Fallback if queue add fails
        socket.emit("call:failed", {
          message: "Unable to connect your call. Please try again.",
        });
      }

      await clearActiveCustomerCall(customerPhone, io);
    }
  }, CALL_TIMEOUT);
};

const clearActiveCustomerCall = async (customerPhone, io = null) => {
  const normalizedPhone = normalizePhone(customerPhone);
  if (!activeCustomerCalls[normalizedPhone]) return;

  console.log(`🧹 Clearing active call for customer ${normalizedPhone}`);

  // Auto-stop recording if still active during cleanup
  const callData = activeCustomerCalls[normalizedPhone];
  if (callData?.egressId) {
    try {
      const recordingService = require('./recordingService');
      // Use fire-and-forget or ensure this doesn't block cleanup if it fails
      recordingService.stopRecording(callData.egressId).catch(err => {
        console.error(`⚠️ Failed to stop recording during call cleanup for ${normalizedPhone}:`, err.message);
      });
    } catch (recErr) {
      console.error(`⚠️ Error triggering recording stop during cleanup for ${normalizedPhone}:`, recErr.message);
    }
  }

  if (activeCustomerCalls[normalizedPhone].timeout) {
    clearTimeout(activeCustomerCalls[normalizedPhone].timeout);
    console.log(`🔄 Cleared timeout for customer ${normalizedPhone}`);
  }

  const currentManagerEmail =
    activeCustomerCalls[normalizedPhone].currentManagerEmail;
  const managerSocketId = activeCustomerCalls[normalizedPhone].managerSocketId;

  if (currentManagerEmail) {
    // Restore manager's previous status (before they accepted the call)
    const previousStatus = activeCustomerCalls[normalizedPhone].managerPreviousStatus || AGENT_STATUS.ONLINE;
    console.log(
      `🔄 Restoring manager ${currentManagerEmail} status to: ${previousStatus}`
    );
    updateUserStatus(currentManagerEmail, "manager", previousStatus);

    // Clear customerPhone from manager's socket
    if (managerSocketId && io) {
      const managerSocket = io.sockets.sockets.get(managerSocketId);
      if (managerSocket && managerSocket.user) {
        delete managerSocket.user.customerPhone;
        console.log(`🧹 Cleared customerPhone from manager ${currentManagerEmail} socket`);
      }
    }
  }

  // Remove from call queue if present
  await removeCustomerFromQueue(normalizedPhone);

  removeCall(normalizedPhone);
  console.log(
    `✅ Successfully cleared call state for customer ${normalizedPhone}`
  );

  // This only deleted the LOCAL copy above. ensureLocalActiveCall clones this
  // entry onto whichever pod happens to handle a CBS/HTTP request mid-call
  // (no session affinity there either) — left uncleaned, that clone survives
  // this call ending, still tagged with this manager's email. A manager who
  // later reconnects (or starts a brand-new call) and lands on that pod gets
  // matched against the dead entry by the reconnect-sync logic and is
  // silently attached to the wrong, long-over call. Broadcasting the same
  // deletion to every pod closes that gap.
  if (io) {
    try {
      io.serverSideEmit("clear-active-call-local", normalizedPhone);
    } catch (error) {
      console.error(`⚠️ Cross-pod active-call cleanup broadcast failed for ${normalizedPhone}:`, error.message);
    }
  }
};

// Local half of the cross-pod cleanup broadcast above — deletes this pod's
// copy of a customer's active call (canonical or cloned) if it has one.
const clearActiveCustomerCallLocal = (normalizedPhone) => {
  if (activeCustomerCalls[normalizedPhone]) {
    delete activeCustomerCalls[normalizedPhone];
    console.log(`🧹 Cleared cross-pod active-call copy for customer ${normalizedPhone}`);
  }
};

// Helper function to broadcast queue and manager status updates
const broadcastQueueAndStatus = async (io) => {
  // Get available managers and filter out those with active calls
  let availableManagers = findAvailableManagers();

  // Filter out managers who already have active calls
  const managersWithActiveCalls = new Set();
  for (const [customerPhone, call] of Object.entries(activeCustomerCalls)) {
    if (call.currentManagerEmail) {
      managersWithActiveCalls.add(call.currentManagerEmail);
    }
    if (call.acceptedManager) {
      managersWithActiveCalls.add(call.acceptedManager);
    }
  }

  availableManagers = availableManagers.filter(m => !managersWithActiveCalls.has(m.email));

  console.log(`📢 Broadcasting manager:list to ${availableManagers.length} available managers`);
  io.emit("manager:list", availableManagers);

  // Get queue data from BullMQ
  const [queue, stats] = await Promise.all([
    getQueuedCustomers(),
    getQueueStats()
  ]);

  console.log(`📢 Broadcasting queue:updated - ${queue.length} customers in queue`);
  io.emit("queue:updated", { queue, stats });

  const allManagers = getAllManagers();
  console.log(`📢 Broadcasting managers:status - ${allManagers.length} total managers`);
  io.emit("managers:status", allManagers);
};

// Helper function to check queue and route call when manager becomes available
const checkQueueAndRouteCall = async (managerSocket, managerEmail, managerName, io) => {
  // Add small delay to ensure BullMQ job is fully persisted to Redis
  // This prevents race condition where getQueuedCustomers() returns empty array
  // immediately after customer joins queue
  console.log(`⏳ Waiting 100ms for BullMQ persistence before checking queue...`);
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log(`✅ BullMQ persistence wait complete, proceeding with queue check`);

  // Get all available managers (not just the one who became available)
  let availableManagers = findAvailableManagers();

  // CRITICAL: Filter out managers who already have active calls
  const managersWithActiveCalls = new Set();
  for (const [customerPhone, call] of Object.entries(activeCustomerCalls)) {
    if (call.currentManagerEmail) {
      managersWithActiveCalls.add(call.currentManagerEmail);
    }
    if (call.acceptedManager) {
      managersWithActiveCalls.add(call.acceptedManager);
    }
  }

  availableManagers = availableManagers.filter(m => !managersWithActiveCalls.has(m.email));

  if (availableManagers.length === 0) {
    console.log(`📋 No available managers to route queue calls (all have active calls or are offline)`);
    return;
  }

  // Get customers from BullMQ queue
  const queuedCustomers = await getQueuedCustomers();

  if (queuedCustomers.length === 0) {
    console.log(`📋 No customers in queue`);
    return;
  }

  const nextInQueue = queuedCustomers[0]; // Get first in queue (highest priority)

  console.log(
    `📋 Found customer ${nextInQueue.customerPhone} in queue, broadcasting to ${availableManagers.length} available managers`
  );

  // Check if customer is still connected (cluster-aware, via Redis adapter)
  const customerSockets = await io.in(nextInQueue.socketId).fetchSockets();
  if (customerSockets.length === 0) {
    console.log(`⚠️ Customer ${nextInQueue.customerPhone} disconnected, removing from queue`);
    await removeCustomerFromQueue(nextInQueue.customerPhone);
    await broadcastQueueAndStatus(io);
    // Try next in queue
    await checkQueueAndRouteCall(managerSocket, managerEmail, managerName, io);
    return;
  }

  const normalizedCustomerPhone = normalizePhone(nextInQueue.customerPhone);
  // Check if customer already has an active call (prevent duplicate routing)
  if (activeCustomerCalls[normalizedCustomerPhone]) {
    console.log(`⚠️ Customer ${normalizedCustomerPhone} already has active call, skipping`);
    return;
  }

  // DON'T remove from queue yet - let the accept handler do it
  // This prevents "customer not found in queue" errors when manager manually picks from queue
  console.log(`📝 Broadcasting call to managers - customer ${normalizedCustomerPhone} stays in queue until accepted`);

  // Create call room
  const roomId = crypto
    .createHash("sha256")
    .update(`${nextInQueue.customerPhone}_queue_${Date.now()}`)
    .digest("hex")
    .slice(0, 16);
  const callRoomLink = `https://${OPENVIDU_DOMAIN}/${roomId}`;

  // BROADCAST to ALL available managers (up to 3)
  const maxBroadcast = 3;
  const selectedManagers = selectManagersForBroadcast(availableManagers, maxBroadcast);

  console.log(
    `📢 Broadcasting queued call to ${selectedManagers.length} managers: ${selectedManagers.map(m => m.email).join(', ')}`
  );

  // Fetch customer info from CBS
  const cbsService = require("./cbsService");
  let customerInfo = {};
  let accountNumber = null;
  try {
    const cbsData = await cbsService.lookupCustomerByPhone(nextInQueue.customerPhone);
    if (cbsData.found) {
      customerInfo = {
        customerName: cbsData.name,
        customerEmail: cbsData.email,
        customerImage: cbsData.profileImage,
        accountNumber: cbsData.accountNumber,
      };
      accountNumber = cbsData.accountNumber;
    }
  } catch (error) {
    console.error(`Error fetching customer info for ${nextInQueue.customerPhone}:`, error);
  }

  // Store active call with broadcast info and verification info
  activeCustomerCalls[normalizedCustomerPhone] = {
    inProgress: true,
    customerSocketId: nextInQueue.socketId,
    broadcastedManagers: new Set(selectedManagers.map(m => m.email)),
    acceptedManager: null, // Will be set when manager accepts
    timeout: null,
    startTime: Date.now(),
    customerPhone: normalizedCustomerPhone,
    accountNumber: accountNumber, // Store for CBS updates
    callRoom: roomId,
    callRoomLink: callRoomLink,
    fromQueue: true,
    verificationInfo: nextInQueue.verificationInfo || null, // { method: 'phone'|'email', phoneOrEmail: '...', isInternal: true|false }
  };
  touchCall(normalizedCustomerPhone);

  // BROADCAST: Send call request to all selected managers simultaneously
  for (const manager of selectedManagers) {
    const mgrSockets = await io.in(manager.socketId).fetchSockets();
    if (mgrSockets.length > 0) {
      // CRITICAL: Do NOT set customerPhone here - only accept handler should set it
      // Setting it during broadcast would overwrite active calls

      // Send call request with verification info
      io.to(manager.socketId).emit("call:request", {
        customerId: nextInQueue.customerPhone,
        customerSocketId: nextInQueue.socketId,
        callRoom: roomId,
        customerPhone: nextInQueue.customerPhone,
        fromQueue: true,
        broadcast: true,
        managersNotified: selectedManagers.length,
        verificationInfo: nextInQueue.verificationInfo || null, // { method: 'phone'|'email', phoneOrEmail: '...', isInternal: true|false }
        ...customerInfo
      });

      console.log(`📞 Sent queued call request to manager ${manager.email}`);
    }
  }

  // Notify customer that managers are being notified
  io.to(nextInQueue.socketId).emit("queue:call-connecting", {
    managersNotified: selectedManagers.length,
    callRoom: roomId,
    message: `${selectedManagers.length} ${selectedManagers.length === 1 ? 'manager is' : 'managers are'} being notified. Please wait...`
  });

  console.log(`📞 Broadcast queued customer ${nextInQueue.customerPhone} to ${selectedManagers.length} managers`);
  console.log(`🔗 Call Room: ${roomId}`);

  // Broadcast queue updates
  await broadcastQueueAndStatus(io);

  // Set timeout: If no manager accepts within 20s, put back in queue with HIGH priority
  activeCustomerCalls[normalizedCustomerPhone].timeout = setTimeout(async () => {
    console.log(`⏳ No manager accepted queued call from ${normalizedCustomerPhone}, re-queuing with HIGH priority`);

    if (!activeCustomerCalls[normalizedCustomerPhone] || activeCustomerCalls[normalizedCustomerPhone].acceptedManager) {
      // Call already accepted or cleared
      return;
    }

    // Cancel call requests to all managers
    for (const manager of selectedManagers) {
      const mgrSockets = await io.in(manager.socketId).fetchSockets();
      if (mgrSockets.length > 0) {
        io.to(manager.socketId).emit("call:cancelled", {
          customerId: nextInQueue.customerPhone,
          reason: "No response - customer re-queued"
        });
      }
      // Local-only cleanup: this custom socket.user property can't be mutated
      // cross-pod via fetchSockets(), so this only clears it if the manager's
      // socket happens to be on this pod. Harmless no-op otherwise.
      const localMgrSocket = io.sockets.sockets.get(manager.socketId);
      if (localMgrSocket?.user) {
        delete localMgrSocket.user.customerPhone;
      }
    }

    // Put customer back in queue with HIGH priority
    const result = await addCustomerToQueue({
      customerPhone: nextInQueue.customerPhone,
      socketId: nextInQueue.socketId,
      customerName: nextInQueue.customerName || null,
      customerEmail: nextInQueue.customerEmail || null,
      priority: 'HIGH'
    });

    // Note: No need to update manager status since they were never set to BUSY
    // (with broadcast routing, status only changes when call is ACCEPTED)
    await clearActiveCustomerCall(nextInQueue.customerPhone, io);
    await broadcastQueueAndStatus(io);

    if (result.success) {
      io.to(nextInQueue.socketId).emit("queue:added", {
        position: result.queuePosition,
        message: "Managers did not respond. You have been placed back in queue with priority.",
        priority: 'HIGH'
      });
    } else {
      io.to(nextInQueue.socketId).emit("call:failed", {
        message: "Unable to reconnect your call. Please try again."
      });
    }
  }, CALL_TIMEOUT);
};

// Export function to get active calls for API
const getActiveCallsData = () => {
  console.log('📞 getActiveCallsData - Total in memory:', Object.keys(activeCustomerCalls).length);
  Object.entries(activeCustomerCalls).forEach(([phone, call]) => {
    console.log(`  - ${phone}: manager=${call.currentManagerEmail}, inProgress=${call.inProgress}`);
  });
  return Object.entries(activeCustomerCalls)
    .filter(([_, call]) => call.currentManagerEmail)
    .map(([customerPhone, call]) => {
      const allManagers = getAllManagers();
      const manager = allManagers.find(m => m.email === call.currentManagerEmail);

      return {
        customerPhone,
        customerName: call.customerName || null,
        customerEmail: call.customerEmail || null,
        managerEmail: call.currentManagerEmail,
        managerName: manager ? manager.name : 'Unknown Manager',
        callRoom: call.callRoom,
        startTime: call.startTime,
        duration: Math.floor((Date.now() - call.startTime) / 1000),
        isOnHold: call.isOnHold || false,
        holdReason: call.holdReason || null,
        phoneVerified: call.phoneVerified || false,
        emailVerified: call.emailVerified || false,
        faceVerified: call.faceVerified || false,
        assistanceRequested: !!call.assistanceRequest,
        supervisors: call.supervisors || [],
        referenceNumber: call.referenceNumber || null
      };
    });
};

// Export function to get online managers for API
const getOnlineManagersData = () => {
  return getAllManagers();
};

// activeCustomerCalls is a plain in-memory object, local to this pod. With
// multiple backend replicas, a REST caller (e.g. the Admin Panel Supervisor
// tab) can land on a pod that never handled the call's socket events, so
// getActiveCallsData() alone would wrongly report "no active calls". This
// asks every other pod for its local active calls (over the Redis adapter's
// serverSideEmit) and merges the results with this pod's own.
const getActiveCallsDataCluster = async (io) => {
  const local = getActiveCallsData();

  if (!io) return local;

  try {
    const remoteResults = await io.serverSideEmitWithAck("get-active-calls-local");
    const merged = [...local, ...remoteResults.flat()];

    const seen = new Set();
    return merged.filter((call) => {
      const key = call.callRoom || call.customerPhone;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (error) {
    console.error("⚠️ Cluster active-calls aggregation failed, falling back to local pod only:", error.message);
    return local;
  }
};

// Ownership check for CBS controller endpoints: is this manager currently
// handling a live call with the customer identified by phone/accountNumber?
// CallLog.customerAccountNumber is never populated by the real call flow, so
// the in-memory activeCustomerCalls map (which does track both) is the only
// reliable source of truth for account-number-based endpoints.
// `io` is optional but required to survive the case where activeCustomerCalls
// for this phone lives on a different pod than the one serving this HTTP
// request (no cross-user pod affinity in k8s) — see ensureLocalActiveCall.
const isManagerAssignedToCustomer = async (managerEmail, { phone, accountNumber } = {}, io) => {
  if (!managerEmail) return false;

  if (phone) {
    const normalizedPhone = normalizePhone(phone);
    const call = activeCustomerCalls[normalizedPhone] || (await ensureLocalActiveCall(io, normalizedPhone));
    return !!call && call.currentManagerEmail === managerEmail;
  }

  if (accountNumber) {
    return Object.values(activeCustomerCalls).some(
      (call) => call.currentManagerEmail === managerEmail && call.customerAccountNumber === accountNumber
    );
  }

  return false;
};

// Serializable snapshot of one local active call for cross-pod requests (see
// ensureLocalActiveCall below). `timeout`/`faceVerificationTimeout` are Node
// Timers (not serializable, and only meaningful on the pod that owns them)
// and `attemptedManagers`/`broadcastedManagers` are Sets (socket.io can't
// transport them as-is), so all four are converted/dropped.
const getActiveCallLocalRaw = (normalizedPhone) => {
  const call = activeCustomerCalls[normalizedPhone];
  if (!call) return null;
  const { timeout, faceVerificationTimeout, attemptedManagers, broadcastedManagers, ...safe } = call;
  return {
    ...safe,
    attemptedManagers: attemptedManagers ? Array.from(attemptedManagers) : [],
    broadcastedManagers: broadcastedManagers ? Array.from(broadcastedManagers) : [],
  };
};

// activeCustomerCalls entries are always created on whichever pod hosts the
// MANAGER's socket connection (queue:pick-call / checkQueueAndRouteCall). A
// customer's own socket connection can land on a *different* pod (no cross-
// user pod affinity in the k8s Service), so a customer-triggered handler
// reading activeCustomerCalls[phone] locally can find nothing even though the
// call is very much active — causing silent, un-logged failures (OTP-verified
// acks never reaching the manager, service requests / chat / whiteboard never
// syncing customer→manager). This does a one-time cross-pod fetch on miss and
// adopts a local copy, so this pod's local reads (and the manager-facing
// notifications they trigger) work correctly for the rest of the call.
const ensureLocalActiveCall = async (io, normalizedPhone) => {
  if (!normalizedPhone) return null;
  if (activeCustomerCalls[normalizedPhone]) return activeCustomerCalls[normalizedPhone];
  if (!io) return null;

  try {
    const results = await io.serverSideEmitWithAck("get-active-call-local", normalizedPhone);
    const found = results.find(Boolean);
    if (!found) return null;

    activeCustomerCalls[normalizedPhone] = {
      ...found,
      timeout: null,
      faceVerificationTimeout: null,
      attemptedManagers: new Set(found.attemptedManagers || []),
      broadcastedManagers: new Set(found.broadcastedManagers || []),
    };
    console.log(`🔁 Adopted cross-pod active-call copy for customer ${normalizedPhone}`);
    return activeCustomerCalls[normalizedPhone];
  } catch (error) {
    console.error(`⚠️ Cross-pod active-call fetch failed for ${normalizedPhone}:`, error.message);
    return null;
  }
};

// Cancels a locally-held disconnect grace-timer, if this pod has one under
// the given key (customer key = normalizedPhone, manager key =
// `mgr:${email}:${normalizedPhone}`). Used by the cross-pod reconnect sync
// below — a reconnecting socket can land on a different pod than the one
// whose timer is actually counting down (no sticky session in the k8s
// Service), so every pod needs a way to cancel a timer it didn't set itself.
const cancelDisconnectTimerLocal = (timerKey) => {
  if (disconnectTimers[timerKey]) {
    clearTimeout(disconnectTimers[timerKey]);
    delete disconnectTimers[timerKey];
    return true;
  }
  return false;
};

// Local half of the cross-pod manager-reconnect sync: runs on every pod in
// response to a serverSideEmitWithAck broadcast, so whichever pod actually
// holds this manager's activeCustomerCalls entry (and its grace timer) can
// update the socketId and cancel its own timer — even though the manager's
// new socket connection landed on a different pod.
const handleManagerReconnectLocal = (io, email, newSocketId) => {
  let custPhone = null;
  Object.keys(activeCustomerCalls).forEach((phone) => {
    const call = activeCustomerCalls[phone];
    if (call.currentManagerEmail === email) {
      custPhone = phone;
      call.managerSocketId = newSocketId;
      touchCall(phone);
      const timerKey = `mgr:${email}:${normalizePhone(phone)}`;
      if (disconnectTimers[timerKey]) {
        clearTimeout(disconnectTimers[timerKey]);
        delete disconnectTimers[timerKey];
        console.log(`✅ Manager ${email} reconnected cross-pod within grace period — call continues (customer ${phone})`);
        const custSocketId = call.customerSocketId;
        if (custSocketId) {
          io.to(custSocketId).emit("manager:reconnected", { message: "Manager reconnected" });
        }
      }
    }
  });
  return custPhone;
};

module.exports = {
  handleSocketConnection,
  getActiveCallsData,
  getActiveCallsDataCluster,
  getOnlineManagersData,
  isManagerAssignedToCustomer,
  getActiveCallLocalRaw,
  ensureLocalActiveCall,
  cancelDisconnectTimerLocal,
  handleManagerReconnectLocal,
  clearActiveCustomerCallLocal,
  activeCustomerCalls,
  activeSupervisors,
};
