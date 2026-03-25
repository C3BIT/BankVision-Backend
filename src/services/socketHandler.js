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
  getQueuePosition,
  getQueuedCustomers,
  getQueueStats,
  PRIORITY
} = require("./callQueueService");
const crypto = require("crypto");
const callLogService = require("./callLogService");
const customerService = require("./customerService");
const cbsMockService = require("./cbsService");
const { Recording } = require("../models");
const faceVerificationService = require("./faceVerificationService");
const { updateSessionSocketId } = require("../utils/sessionManager");
const OTP = require("./otpService");

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
const rejectedManagers = {};
const activeSupervisors = {}; // Track supervisors monitoring calls

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
    socket.emit("error", { message: "Invalid connection data" });
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
        }
      } else if (role === "manager" && email) {
        // Find if this manager has any active calls and update their socketId
        let hasActiveCall = false;
        Object.keys(activeCustomerCalls).forEach(custPhone => {
          if (activeCustomerCalls[custPhone].currentManagerEmail === email) {
            console.log(`♻️ Manager ${email} reconnected - updating active call with ${custPhone} to socketId: ${socketId}`);
            activeCustomerCalls[custPhone].managerSocketId = socketId;
            // Restore customerPhone on the new socket so manager operations work
            socket.user.customerPhone = custPhone;
            hasActiveCall = true;
          }
        });

        // If no active call, reset status to online (Redis may still have "busy" from a previous call)
        if (!hasActiveCall) {
          updateUserStatus(email, "manager", AGENT_STATUS.ONLINE);
          console.log(`🟢 Manager ${email} reconnected with no active call — status reset to online`);
        }
      }
    }

    if (role === "customer") {
      socket.emit("manager:list", findAvailableManagers());
    }

    socket.on("call:initiate", async (data) => {
      if (role !== "customer") return;

      const { verificationInfo } = data || {};
      console.log(`🔄 Customer ${phone} initiating call - checking customer registration (optional)`);
      console.log(`📋 Verification info:`, verificationInfo);

      // Try to check customer in CBS (optional - not blocking)
      // If not found, manager will see "no data found" in info panel
      let customerAccounts = [];
      try {
        customerAccounts = await customerService.getAccountsListByPhone(phone);
        if (customerAccounts && customerAccounts.length > 0) {
          console.log(`✅ Customer ${phone} found in CBS with ${customerAccounts.length} account(s)`);
        } else {
          console.log(`ℹ️ Customer ${phone} not found in CBS - proceeding anyway (manager will see "no data found")`);
        }
      } catch (error) {
        console.log(`ℹ️ Customer lookup failed (non-blocking):`, error.message);
        console.log(`ℹ️ Proceeding with call - manager will see "no data found"`);
        // Don't block - proceed with call
      }

      await clearActiveCustomerCall(phone, io);

      // Check if verification phone/email is in bank database (for internal vs external determination)
      let isInternal = false;
      let verificationPhoneOrEmail = null;

      if (verificationInfo && verificationInfo.phoneOrEmail) {
        verificationPhoneOrEmail = verificationInfo.phoneOrEmail;

        // Check if verification phone/email exists in bank database
        try {
          if (verificationInfo.method === 'phone') {
            const accounts = await customerService.getAccountsListByPhone(verificationPhoneOrEmail);
            isInternal = accounts && accounts.length > 0;
          } else if (verificationInfo.method === 'email') {
            // Check if email exists in any customer account
            const accounts = await customerService.getAccountsListByPhone(phone);
            isInternal = accounts.some(acc => acc.email === verificationPhoneOrEmail);
          }
          console.log(`🔍 Verification ${verificationInfo.method} ${verificationPhoneOrEmail} is ${isInternal ? 'INTERNAL' : 'EXTERNAL'} (${isInternal ? 'in bank' : 'not in bank'})`);
        } catch (error) {
          console.error(`⚠️ Error checking verification status:`, error);
          isInternal = false; // Default to external if check fails
        }
      }

      // Look up customer name/email from CBS/DB if not already known
      let resolvedName = name || null;
      let resolvedEmail = socket.user.customerEmail || null;
      let isGuest = true;
      if (customerAccounts && customerAccounts.length > 0) {
        isGuest = false;
      }
      if (!resolvedName || !resolvedEmail) {
        try {
          const lookup = await cbsMockService.lookupCustomerByPhone(phone);
          if (lookup && lookup.found) {
            if (!resolvedName) resolvedName = lookup.name || null;
            if (!resolvedEmail && lookup.email) resolvedEmail = lookup.email;
          }
        } catch (err) {
          console.log(`ℹ️ Customer CBS lookup failed (non-blocking):`, err.message);
        }
      }
      // If still no name, mark as Guest
      if (!resolvedName) {
        resolvedName = 'Guest';
      }

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
    });

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
    socket.on("call:end", async () => {
      if (role === "customer") {
        console.log(`🔄 Customer ${phone} ended call`);

        // Notify manager about call end BEFORE clearing state
        if (activeCustomerCalls[phone]?.currentManagerEmail) {
          const managerEmail = activeCustomerCalls[phone].currentManagerEmail;
          // Find current manager socket ID robustly
          const managerSocketId = getOnlineUsersWithInfo().find(
            (user) => user.email === managerEmail
          )?.socketId || activeCustomerCalls[phone].managerSocketId;

          console.log(`📣 Notifying manager ${managerEmail} (socket: ${managerSocketId}) about customer ${phone} ending call`);

          if (managerSocketId) {
            const managerSocket = io.sockets.sockets.get(managerSocketId);
            if (managerSocket && managerSocket.connected) {
              const eventData = {
                customerId: phone,
                customerName: name || null,
                endedBy: "customer",
                callLogId: activeCustomerCalls[phone].callLogId || null,
                referenceNumber: activeCustomerCalls[phone].referenceNumber || null,
              };
              io.to(managerSocketId).emit("call:ended", eventData);
              console.log(`✅ Successfully sent call:ended event to manager ${managerEmail} (socket: ${managerSocketId})`);
              console.log(`   Event data:`, JSON.stringify(eventData));
            } else {
              console.log(`⚠️ Manager socket ${managerSocketId} not found or not connected`);
              console.log(`   Socket exists: ${!!managerSocket}, Connected: ${managerSocket?.connected}`);
            }
          } else {
            console.log(`⚠️ No manager socket ID found for customer ${phone}`);
            console.log(`   Active call data:`, JSON.stringify(activeCustomerCalls[phone]));
          }
        } else {
          console.log(`⚠️ No active call data found for customer ${phone}`);
        }

        // Auto-stop recording
        const callData = activeCustomerCalls[phone];
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

        // Complete call log
        if (activeCustomerCalls[phone]?.callRoom) {
          try {
            await callLogService.completeCall(
              activeCustomerCalls[phone].callRoom,
              "customer",
              {
                phoneVerified: activeCustomerCalls[phone].phoneVerified || false,
                emailVerified: activeCustomerCalls[phone].emailVerified || false,
                faceVerified: activeCustomerCalls[phone].faceVerified || false,
                chatMessagesCount: activeCustomerCalls[phone].chatMessagesCount || 0
              }
            );
          } catch (err) {
            console.error("❌ Error completing call log:", err);
          }
        }

        // Get manager info before clearing call state
        const managerEmail = activeCustomerCalls[phone]?.currentManagerEmail;
        const managerSocketId = activeCustomerCalls[phone]?.managerSocketId;
        const managerSocket = managerSocketId ? io.sockets.sockets.get(managerSocketId) : null;

        // Clear call and reset manager status
        await clearActiveCustomerCall(phone, io);

        // Notify customer that call has ended (confirm their end request)
        socket.emit("call:ended", {
          endedBy: "customer",
          message: "Call ended successfully"
        });
        console.log(`✅ Sent call:ended confirmation to customer ${phone}`);

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
        if (customerPhone && activeCustomerCalls[customerPhone]) {
          console.log(
            `🔄 Manager ${email} ended call with customer ${customerPhone}`
          );

          // Auto-stop recording
          const callData = activeCustomerCalls[customerPhone];
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

          // Complete call log
          if (activeCustomerCalls[customerPhone]?.callRoom) {
            try {
              await callLogService.completeCall(
                activeCustomerCalls[customerPhone].callRoom,
                "manager",
                {
                  phoneVerified: activeCustomerCalls[customerPhone].phoneVerified || false,
                  emailVerified: activeCustomerCalls[customerPhone].emailVerified || false,
                  faceVerified: activeCustomerCalls[customerPhone].faceVerified || false,
                  chatMessagesCount: activeCustomerCalls[customerPhone].chatMessagesCount || 0
                }
              );
            } catch (err) {
              console.error("❌ Error completing call log:", err);
            }
          }

          // Notify customer that manager ended the call
          const customerSocketId = activeCustomerCalls[customerPhone].customerSocketId;
          const customerSocket = io.sockets.sockets.get(customerSocketId);

          console.log(`📤 Preparing to send call:ended to customer ${customerPhone}`);
          console.log(`   Customer socket ID: ${customerSocketId}`);
          console.log(`   Customer socket exists: ${!!customerSocket}`);
          console.log(`   Customer socket connected: ${customerSocket?.connected || false}`);

          if (customerSocket && customerSocket.connected) {
            customerSocket.emit("call:ended", {
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
            callLogId: activeCustomerCalls[customerPhone].callLogId || null,
            referenceNumber: activeCustomerCalls[customerPhone].referenceNumber || null,
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
        return socket.emit("error", { message: "Invalid status" });
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
          return socket.emit("error", { message: "No active call" });
        }
        const call = activeCustomerCalls[customerPhone];
        if (call.isRecording) {
          return socket.emit("error", { message: "Recording already in progress" });
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
          socket.emit("error", { message: "Failed to start recording" });
        }
      } else {
        socket.emit("error", { message: "Unauthorized" });
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
          return socket.emit("error", { message: "No active call" });
        }
        const call = activeCustomerCalls[customerPhone];
        if (!call.isRecording || !call.recordingId) {
          return socket.emit("error", { message: "No recording in progress" });
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
          socket.emit("error", { message: "Failed to stop recording" });
        }
      } else {
        socket.emit("error", { message: "Unauthorized" });
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
        return socket.emit("error", { message: "Customer not found in queue" });
      }

      // Remove from BullMQ queue
      const removed = await removeCustomerFromQueue(customerPhone);
      if (!removed) {
        return socket.emit("error", { message: "Failed to remove customer from queue" });
      }

      // Check if customer is still connected
      const customerSocket = io.sockets.sockets.get(queueEntry.socketId);
      if (!customerSocket) {
        return socket.emit("error", { message: "Customer has disconnected" });
      }

      // Initiate call to this customer
      console.log(`📞 Manager ${email} picked call from queue for customer ${customerPhone}`);

      // Update manager status
      updateUserStatus(email, role, AGENT_STATUS.BUSY);

      // Create call room
      const callRoom = `room_${customerPhone}_${Date.now()}`;

      // Store active call with verification info
      const normalizedPhone = normalizePhone(customerPhone);

      // Get account number from CBS if possible
      let accountNumber = null;
      try {
        const lookup = await cbsMockService.lookupCustomerByPhone(normalizedPhone);
        if (lookup && lookup.found) {
          accountNumber = lookup.accountNumber;
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
        callRoom: callRoom,
        verificationInfo: queueEntry.verificationInfo || null, // { method: 'phone'|'email', phoneOrEmail: '...', isInternal: true|false }
      };

      socket.user.customerPhone = normalizedPhone;

      // Store manager's previous status before setting to BUSY
      const allManagers = getAllManagers();
      const currentManager = allManagers.find(m => m.email === email);
      const previousStatus = currentManager?.status || AGENT_STATUS.ONLINE;
      activeCustomerCalls[normalizedPhone].managerPreviousStatus = previousStatus;

      // Create call log entry
      try {
        const callLog = await callLogService.createCallLog({
          callRoom: callRoom,
          customerPhone: customerPhone,
          customerName: queueEntry.customerName || null,
          customerEmail: queueEntry.customerEmail || null,
          managerEmail: email,
          managerName: name || null,
          queueWaitTime: queueEntry.waitTimeSeconds || 0,
          metadata: { pickedFromQueue: true }
        });
        activeCustomerCalls[customerPhone].callLogId = callLog?.id;
        activeCustomerCalls[customerPhone].referenceNumber = callLog?.referenceNumber;
        await callLogService.acceptCall(callRoom);

        // Auto-start recording after delay (wait for participants to join)
        setTimeout(async () => {
          try {
            if (!activeCustomerCalls[customerPhone]) {
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
                    callLogId: callLog?.id,
                    recordedBy: 'auto'
                  }
                );
                if (recordingResult.success) {
                  activeCustomerCalls[customerPhone].egressId = recordingResult.egressId;
                  activeCustomerCalls[customerPhone].recordingId = recordingResult.recordingId;
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

      // Notify manager that call is starting (sets callStatus='in-call' in manager panel)
      socket.emit("call:accepted", {
        customerId: customerPhone,
        customerPhone: customerPhone,
        customerName: queueEntry.customerName || null,
        customerEmail: queueEntry.customerEmail || null,
        callRoom: callRoom,
        referenceNumber: activeCustomerCalls[customerPhone].referenceNumber || null,
        routingTime: queueEntry.waitTimeSeconds * 1000 || 0,
        verificationInfo: queueEntry.verificationInfo || null, // { method: 'phone'|'email', phoneOrEmail: '...', isInternal: true|false }
      });

      // Notify customer that manager accepted
      customerSocket.emit("call:accepted", {
        managerId: email,
        managerName: name || null,
        ...(socket.user.image && { managerImage: socket.user.image }),
        callRoom: callRoom,
        referenceNumber: activeCustomerCalls[customerPhone].referenceNumber || null,
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
        socket.emit("error", {
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
        return socket.emit("error", {
          message: "No active call with customer found.",
        });
      }

      let customerSocketId = activeCustomerCalls[customerPhone].customerSocketId;

      // Validate stored socket is still active; if stale, search by phone
      if (!customerSocketId || !io.sockets.sockets.get(customerSocketId)) {
        console.log(`⚠️ Stored customer socket ${customerSocketId} is stale, searching for active socket by phone ${customerPhone}`);
        for (const [, s] of io.sockets.sockets) {
          if (s.user && normalizePhone(s.user.phone) === customerPhone) {
            customerSocketId = s.id;
            activeCustomerCalls[customerPhone].customerSocketId = customerSocketId;
            console.log(`✅ Found active customer socket: ${customerSocketId}`);
            break;
          }
        }
      }

      if (!customerSocketId) {
        console.error(`❌ No active socket found for customer ${customerPhone}`);
        return socket.emit("error", { message: "Customer is not connected." });
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
        socket.emit("error", { message: "Failed to send OTP to customer." });
      }
    });

    socket.on("customer:phone-verified", async (data) => {
      if (role !== "customer") return;

      const normalizedPhone = normalizePhone(phone);
      console.log(`✅ Customer ${normalizedPhone} verified phone number`);

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      // Track verification in active call
      activeCustomerCalls[normalizedPhone].phoneVerified = true;

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
        return socket.emit("error", {
          message: "No active call with customer",
        });
      }

      if (!customerEmail) {
        console.log(`⚠️ No email provided for customer ${customerPhone}`);
        return socket.emit("error", {
          message: "Customer email is required",
        });
      }

      let customerSocketId = activeCustomerCalls[customerPhone].customerSocketId;

      // Validate stored socket is still active; if stale, search by phone
      if (!customerSocketId || !io.sockets.sockets.get(customerSocketId)) {
        console.log(`⚠️ Stored customer socket ${customerSocketId} is stale, searching for active socket by phone ${customerPhone}`);
        for (const [, s] of io.sockets.sockets) {
          if (s.user && normalizePhone(s.user.phone) === customerPhone) {
            customerSocketId = s.id;
            activeCustomerCalls[customerPhone].customerSocketId = customerSocketId;
            console.log(`✅ Found active customer socket: ${customerSocketId}`);
            break;
          }
        }
      }

      if (!customerSocketId) {
        console.error(`❌ No active socket found for customer ${customerPhone}`);
        return socket.emit("error", { message: "Customer is not connected." });
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
        socket.emit("error", { message: "Failed to send email OTP to customer." });
      }
    });

    socket.on("customer:email-verified", async (data) => {
      if (role !== "customer") return;

      const normalizedPhone = normalizePhone(phone);
      console.log(`✅ Customer ${normalizedPhone} verified email address`);

      const activeCall = activeCustomerCalls[normalizedPhone];
      if (!activeCall || !activeCall.currentManagerEmail) {
        console.log(`⚠️ No active call found for customer ${normalizedPhone}`);
        return;
      }

      // Track verification in active call
      activeCustomerCalls[normalizedPhone].emailVerified = true;

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
        return socket.emit("error", {
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
        return socket.emit("error", {
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
        return socket.emit("error", {
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
        return socket.emit("error", {
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
    socket.on("manager:initiate-face-verification", (data) => {
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

      // Check if customer socket is still connected
      const customerSocket = io.sockets.sockets.get(customerSocketId);
      if (!customerSocket) {
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
        }
      }, timeoutDuration);

      // Store timeout ID for cleanup
      activeCustomerCalls[customerPhone].faceVerificationTimeout = timeoutId;

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
        return socket.emit("error", { message: "No active call found with this customer" });
      }

      // Ensure manager socket ID is fresh
      activeCall.managerSocketId = socket.id;

      // Find current customer socket ID robustly
      const customerSocketId = getOnlineUsersWithInfo().find(
        (user) => user.phone === customerPhone
      )?.socketId || activeCall.customerSocketId;

      if (!customerSocketId) {
        return socket.emit("error", { message: "Customer is not currently connected" });
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

    socket.on("customer:signature-uploaded", (data) => {
      if (role !== "customer") return;

      const { signaturePath, timestamp } = data;
      const normalizedPhone = normalizePhone(phone);
      console.log(`✍️ Customer ${normalizedPhone} uploaded signature: ${signaturePath}`);

      const activeCall = activeCustomerCalls[normalizedPhone];
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
        io.to(managerSocketId).emit("customer:signature-uploaded", {
          customerId: phone,
          signaturePath,
          timestamp,
          managerEmail: activeCall.currentManagerEmail // Add for verification
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
        return socket.emit("error", {
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
        return socket.emit("error", {
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
        return socket.emit("error", {
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
        return socket.emit("error", {
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

    socket.on("manager:request-address-change", () => {
      if (role !== "manager") return;

      const customerPhone = normalizePhone(socket.user.customerPhone);
      console.log(`🏠 Manager ${email} requesting address change for customer ${customerPhone}`);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("error", {
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
    socket.on("customer:submit-change-request", (data) => {
      // Allow both customer and manager to trigger this
      // If manager triggers it, it's a "submit on behalf" flow
      const { changeType, newValue, currentValue, verified } = data;

      // When manager triggers this, look up customer by customerPhone, not manager's own phone
      const lookupPhone = role === 'manager'
        ? normalizePhone(socket.user?.customerPhone)
        : normalizePhone(phone);

      const activeCall = activeCustomerCalls[lookupPhone];

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

        // Save audit record for manager override flow
        (async () => {
          try {
            const ChangeRequest = require("../models/ChangeRequest");
            await ChangeRequest.create({
              customerId: lookupPhone,
              managerId: socket.user.id,
              changeType,
              oldValue: currentValue || '',
              newValue,
              status: 'approved',
              method: 'manager_override',
              notes: `Manager sent OTP to new ${changeType} and verified directly on behalf of customer. No separate approval dialog required.`,
              ipAddress: socket.handshake.address,
              userAgent: socket.handshake.headers['user-agent'],
            });
            console.log(`📋 Audit record saved: manager override ${changeType} change for ${lookupPhone}`);
          } catch (auditErr) {
            console.error('❌ Failed to save manager override audit record:', auditErr);
          }
        })();
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
    socket.on("customer:submit-address-change-request", (data) => {
      // Allow both customer and manager to trigger this
      const { addressType, addressData } = data;

      // When manager triggers this, look up customer by customerPhone, not manager's own phone
      const lookupPhone = role === 'manager'
        ? normalizePhone(socket.user?.customerPhone)
        : normalizePhone(phone);

      const activeCall = activeCustomerCalls[lookupPhone];

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
        });
        console.log(`✅ Address change request forwarded to manager ${activeCall.currentManagerEmail}`);
      }

      // Also notify customer that address change is pending approval
      if (activeCall.customerSocketId) {
        io.to(activeCall.customerSocketId).emit("customer:submit-address-change-request", {
          addressType,
          addressData,
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
        socket.emit("error", { message: `Failed to resend ${type} OTP` });
      }
    });

    // Manager approves change (phone/email)
    socket.on("manager:approve-change", async (data) => {
      if (role !== "manager") return;

      const { changeType, customerId, newValue, currentValue } = data;
      const normalizedCustomerId = normalizePhone(customerId);
      const ChangeRequest = require("../models/ChangeRequest");
      console.log(`✅ Manager ${email} approved ${changeType} change for customer ${normalizedCustomerId}: ${currentValue} → ${newValue}`);

      if (!activeCustomerCalls[normalizedCustomerId]) {
        console.log(`⚠️ No active call found for customer ${normalizedCustomerId}`);
        return;
      }

      try {
        const accountNumber = activeCustomerCalls[normalizedCustomerId].customerAccountNumber
          || activeCustomerCalls[normalizedCustomerId].accountNumber;

        // Save audit record BEFORE CBS call — always captured regardless of CBS outcome
        await ChangeRequest.create({
          customerId,
          managerId: socket.user.id,
          changeType,
          oldValue: currentValue || '',
          newValue,
          status: 'approved',
          method: 'standard',
          notes: `Manager approved ${changeType} change via approval dialog. Account: ${accountNumber || 'N/A'}.`,
          ipAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent']
        });

        // Update CBS system
        if (changeType === "phone") {
          await emitCbsLog(
            "POST /cbs/api/v1/customer/phone/update",
            { accountNumber, requestId: "MOCK_BACKEND_APPROVAL", otp: "verified", newPhone: newValue },
            () => cbsMockService.updatePhone(accountNumber, "MOCK_BACKEND_APPROVAL", "verified", newValue)
          );
        } else if (changeType === "email") {
          await emitCbsLog(
            "POST /cbs/api/v1/customer/email/update",
            { accountNumber, requestId: "MOCK_BACKEND_APPROVAL", otp: "verified", newEmail: newValue },
            () => cbsMockService.updateEmail(accountNumber, "MOCK_BACKEND_APPROVAL", "verified", newValue)
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
        socket.emit("error", { message: "Failed to update record in banking system" });
      }
    });

    // Manager rejects change (phone/email)
    socket.on("manager:reject-change", async (data) => {
      if (role !== "manager") return;

      const { changeType, customerId, reason, currentValue } = data;
      const normalizedCustomerId = normalizePhone(customerId);
      const ChangeRequest = require("../models/ChangeRequest");
      console.log(`❌ Manager ${email} rejected ${changeType} change for customer ${normalizedCustomerId}: ${reason}`);

      if (!activeCustomerCalls[normalizedCustomerId]) {
        console.log(`⚠️ No active call found for customer ${normalizedCustomerId}`);
        return;
      }

      try {
        // Create audit record
        await ChangeRequest.create({
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
        socket.emit("error", { message: "Failed to reject change request" });
      }
    });

    // Manager approves address change
    socket.on("manager:approve-address-change", async (data) => {
      if (role !== "manager") return;

      const { customerId, addressType, addressData } = data;
      const normalizedCustomerId = normalizePhone(customerId);
      const ChangeRequest = require("../models/ChangeRequest");
      console.log(`✅ Manager ${email} approved ${addressType} address change for customer ${normalizedCustomerId}`);

      if (!activeCustomerCalls[normalizedCustomerId]) {
        console.log(`⚠️ No active call found for customer ${normalizedCustomerId}`);
        return;
      }

      try {
        const accountNumber = activeCustomerCalls[normalizedCustomerId].customerAccountNumber
          || activeCustomerCalls[normalizedCustomerId].accountNumber;
        const formattedAddress = `${addressData.addressLine1}, ${addressData.addressLine2 ? addressData.addressLine2 + ", " : ""}${addressData.upazila}, ${addressData.district} - ${addressData.postCode}`;

        // Save audit record BEFORE CBS call — always captured regardless of CBS outcome
        await ChangeRequest.create({
          customerId,
          managerId: socket.user.id,
          changeType: 'address',
          newValue: JSON.stringify({ addressType, ...addressData }),
          status: 'approved',
          method: 'standard',
          notes: `Manager approved ${addressType} address change via approval dialog. Account: ${accountNumber || 'N/A'}. New address: ${formattedAddress}`,
          ipAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent']
        });

        // Update CBS system
        await emitCbsLog(
          "POST /cbs/api/v1/customer/address/update",
          { accountNumber, requestId: "MOCK_BACKEND_APPROVAL", otp: "verified", newAddress: formattedAddress, addressType },
          () => cbsMockService.updateAddress(accountNumber, "MOCK_BACKEND_APPROVAL", "verified", formattedAddress, addressType)
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
        socket.emit("error", { message: "Failed to update address in banking system" });
      }
    });

    // Manager rejects address change
    socket.on("manager:reject-address-change", async (data) => {
      if (role !== "manager") return;

      const { customerId, addressType, reason } = data;
      const normalizedCustomerId = normalizePhone(customerId);
      const ChangeRequest = require("../models/ChangeRequest");
      console.log(`❌ Manager ${email} rejected ${addressType} address change for customer ${normalizedCustomerId}: ${reason}`);

      if (!activeCustomerCalls[normalizedCustomerId]) {
        console.log(`⚠️ No active call found for customer ${normalizedCustomerId}`);
        return;
      }

      try {
        // Create audit record
        await ChangeRequest.create({
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
        socket.emit("error", { message: "Failed to reject address change" });
      }
    });

    // Manager approves account activation
    socket.on("manager:approve-account-activation", async (data) => {
      if (role !== "manager") return;

      const { customerId, accountNumber } = data;
      const normalizedCustomerId = normalizePhone(customerId);
      console.log(`✅ Manager ${email} approved account activation for customer ${normalizedCustomerId}`);

      if (!activeCustomerCalls[normalizedCustomerId]) {
        console.log(`⚠️ No active call found for customer ${normalizedCustomerId}`);
        return;
      }

      const ChangeRequest = require("../models/ChangeRequest");
      try {
        // Save audit record BEFORE CBS call
        await ChangeRequest.create({
          customerId: normalizedCustomerId,
          managerId: socket.user.id,
          changeType: 'address', // closest available type; account activation is a separate flow
          newValue: JSON.stringify({ action: 'account_activation', accountNumber }),
          status: 'approved',
          method: 'standard',
          notes: `Manager approved dormant account activation via approval dialog. Account: ${accountNumber}.`,
          ipAddress: socket.handshake.address,
          userAgent: socket.handshake.headers['user-agent']
        }).catch(err => console.error('⚠️ Audit save failed for account activation:', err.message));

        // Update CBS
        await emitCbsLog(
          "POST /cbs/api/v1/account/activate",
          { accountNumber, requestId: "MOCK_BACKEND_APPROVAL", otp: "verified", nidNumber: "MOCK_NID_0000000000" },
          () => cbsMockService.activateAccount(accountNumber, "MOCK_BACKEND_APPROVAL", "verified", "MOCK_NID_0000000000")
        );

        io.to(activeCustomerCalls[normalizedCustomerId].customerSocketId).emit(
          "customer:account-activated",
          {
            accountNumber,
            message: "Your dormant account has been successfully activated in banking system",
          }
        );
      } catch (cbsError) {
        console.error(`❌ CBS Activation Error:`, cbsError);
        socket.emit("error", { message: "Failed to activate account in banking system" });
      }

      console.log(`✅ Activation notification sent to customer ${normalizedCustomerId}`);
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
        return socket.emit("error", {
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

      // Broadcast to all supervisors/admins
      io.emit("supervisor:assistance-requested", assistanceRequest);

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
        assistanceRequest.status = "cancelled";

        // Broadcast cancellation
        io.emit("supervisor:assistance-cancelled", {
          requestId: assistanceRequest.requestId,
          managerEmail: email,
          customerPhone: customerPhone,
          timestamp: Date.now()
        });

        delete activeCustomerCalls[customerPhone].assistanceRequest;

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
        return socket.emit("error", { message: "Call not found" });
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
        return socket.emit("error", { message: "No active call to transfer" });
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
        return socket.emit("error", { message: "Transfer request not found or expired" });
      }

      if (transfer.targetManagerEmail !== email) {
        return socket.emit("error", { message: "You are not the target of this transfer" });
      }

      const customerPhone = normalizePhone(transfer.customerPhone);
      const activeCall = activeCustomerCalls[customerPhone];

      if (!activeCall) {
        delete pendingTransfers[transferId];
        return socket.emit("error", { message: "Call no longer active" });
      }

      // Update call with new manager
      const previousManager = activeCall.currentManagerEmail;
      activeCall.currentManagerEmail = email;
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
        return socket.emit("error", { message: "Transfer request not found or expired" });
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
        return socket.emit("error", { message: "Call not found" });
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
        return socket.emit("error", { message: "Call not found" });
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
      }

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
        return socket.emit("error", { message: "Call not found" });
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
      }

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
        return socket.emit("error", { message: "Call not found" });
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
        return socket.emit("error", { message: "No active call" });
      }

      const call = activeCustomerCalls[customerPhone];
      const supervisor = call.supervisors?.find(s => s.id === supervisorId);

      if (!supervisor) {
        return socket.emit("error", { message: "Supervisor not found in call" });
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
        return socket.emit("error", { message: "Call not found" });
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
      }

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
        return socket.emit("error", { message: "Call not found" });
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
        return socket.emit("error", { message: "Call not found" });
      }

      const call = activeCustomerCalls[customerPhone];
      const supervisorId = email || socket.id;

      // Remove supervisor from call
      if (call.supervisors) {
        call.supervisors = call.supervisors.filter(s => s.id !== supervisorId);
      }

      // Remove from activeSupervisors
      delete activeSupervisors[socket.id];

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

    // ============ CALL HOLD EVENTS ============
    socket.on("manager:hold-call", (data) => {
      if (role !== "manager") return;

      const customerPhone = socket.user.customerPhone;
      const { reason = "" } = data || {};

      console.log(`⏸️ Manager ${email} putting call on hold for customer ${customerPhone}`);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("error", {
          message: "No active call with customer",
        });
      }

      activeCustomerCalls[customerPhone].isOnHold = true;
      activeCustomerCalls[customerPhone].holdStartTime = Date.now();
      activeCustomerCalls[customerPhone].holdReason = reason;

      // Notify customer
      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "call:on-hold",
        {
          managerId: email,
          managerName: name || null,
          reason: reason,
          timestamp: Date.now()
        }
      );

      // Confirm to manager
      socket.emit("manager:call-on-hold", {
        customerPhone: customerPhone,
        timestamp: Date.now()
      });

      console.log(`⏸️ Call put on hold for customer ${customerPhone}`);
    });

    socket.on("manager:resume-call", (data) => {
      if (role !== "manager") return;

      const customerPhone = socket.user.customerPhone;

      console.log(`▶️ Manager ${email} resuming call with customer ${customerPhone}`);

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("error", {
          message: "No active call with customer",
        });
      }

      const holdDuration = activeCustomerCalls[customerPhone].holdStartTime
        ? Math.floor((Date.now() - activeCustomerCalls[customerPhone].holdStartTime) / 1000)
        : 0;

      activeCustomerCalls[customerPhone].isOnHold = false;
      activeCustomerCalls[customerPhone].totalHoldTime =
        (activeCustomerCalls[customerPhone].totalHoldTime || 0) + holdDuration;
      delete activeCustomerCalls[customerPhone].holdStartTime;
      delete activeCustomerCalls[customerPhone].holdReason;

      // Notify customer
      io.to(activeCustomerCalls[customerPhone].customerSocketId).emit(
        "call:resumed",
        {
          managerId: email,
          managerName: name || null,
          holdDuration: holdDuration,
          timestamp: Date.now()
        }
      );

      // Confirm to manager
      socket.emit("manager:call-resumed", {
        customerPhone: customerPhone,
        holdDuration: holdDuration,
        timestamp: Date.now()
      });

      console.log(`▶️ Call resumed for customer ${customerPhone}, hold duration: ${holdDuration}s`);
    });
    // ============ END CALL HOLD EVENTS ============

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
        return socket.emit("error", {
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

    socket.on("manager:request-retake-image", (data) => {
      if (role !== "manager") return;

      const customerPhone = socket.user.customerPhone;

      if (!customerPhone || !activeCustomerCalls[customerPhone]) {
        console.log(`⚠️ No active call found for customer ${customerPhone}`);
        return socket.emit("error", {
          message: "No active call with customer",
        });
      }

      const customerSocketId = activeCustomerCalls[customerPhone].customerSocketId;

      // Clear any existing timeout
      if (activeCustomerCalls[customerPhone].faceVerificationTimeout) {
        clearTimeout(activeCustomerCalls[customerPhone].faceVerificationTimeout);
        delete activeCustomerCalls[customerPhone].faceVerificationTimeout;
      }

      // Check if customer is still connected
      const customerSocket = io.sockets.sockets.get(customerSocketId);
      if (!customerSocket) {
        return socket.emit("error", {
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
        return socket.emit("error", {
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
        return socket.emit("error", {
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

      // Auto-verify face using mock service (will use OpenCV API later)
      try {
        console.log(`🔍 Starting face verification for customer ${normalizedPhone}`);
        // Get NID data if available for comparison
        const nidData = activeCall.nidData || null;

        let verificationResult;
        if (nidData && nidData.photo) {
          // Compare with NID photo
          verificationResult = await faceVerificationService.verifyFaceAgainstNID(
            normalizedPhone,
            imageBase64 || imagePath,
            nidData
          );
        } else {
          // Quick verification without NID reference
          verificationResult = await faceVerificationService.quickVerifyFace(
            normalizedPhone,
            imageBase64 || imagePath
          );
        }

        console.log(`📊 Face verification result for ${normalizedPhone}:`, verificationResult);

        // Update active call with verification result
        if (verificationResult.verified) {
          activeCustomerCalls[normalizedPhone].faceVerified = true;
          activeCustomerCalls[normalizedPhone].faceMatchScore = verificationResult.score;

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
        return socket.emit("error", { message: "No active call with customer" });
      }

      const { verificationStatus } = data;
      const isVerified = verificationStatus === "verified";

      // Track face verification in active call
      if (isVerified) {
        activeCustomerCalls[customerPhone].faceVerified = true;

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
        return socket.emit("error", { message: "No active call with customer" });
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
    socket.on("chat:send", (data) => {
      const { message, timestamp } = data;
      const messageId = crypto.randomUUID();

      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);

        if (!customerPhone || !activeCustomerCalls[customerPhone]) {
          console.log(`⚠️ No active call found for chat message from manager ${email}`);
          return socket.emit("error", { message: "No active call with customer" });
        }

        // Increment chat message count
        activeCustomerCalls[customerPhone].chatMessagesCount =
          (activeCustomerCalls[customerPhone].chatMessagesCount || 0) + 1;

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
        const activeCall = activeCustomerCalls[normalizedPhone];

        if (!activeCall || !activeCall.currentManagerEmail) {
          console.log(`⚠️ No active call found for chat message from customer ${normalizedPhone}`);
          return socket.emit("error", { message: "No active call with manager" });
        }

        // Increment chat message count
        activeCustomerCalls[normalizedPhone].chatMessagesCount =
          (activeCustomerCalls[normalizedPhone].chatMessagesCount || 0) + 1;

        const managerSocketId = getOnlineUsersWithInfo().find(
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
        }
      }
    });

    socket.on("chat:typing", (data) => {
      const { isTyping } = data;

      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);

        if (!customerPhone || !activeCustomerCalls[customerPhone]) return;

        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("chat:typing", {
          senderId: email,
          senderRole: "manager",
          isTyping
        });

      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = activeCustomerCalls[normalizedPhone];

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

    socket.on("whiteboard:stroke", (data) => {
      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);
        if (!customerPhone || !activeCustomerCalls[customerPhone]) return;
        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("whiteboard:stroke", {
          ...data,
          senderId: email,
          senderRole: "manager",
        });
      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = activeCustomerCalls[normalizedPhone];
        if (!activeCall || !activeCall.managerSocketId) return;
        io.to(activeCall.managerSocketId).emit("whiteboard:stroke", {
          ...data,
          senderId: phone,
          senderRole: "customer",
        });
      }
    });

    socket.on("whiteboard:clear", (data) => {
      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);
        if (!customerPhone || !activeCustomerCalls[customerPhone]) return;
        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("whiteboard:clear", {
          senderId: email,
          senderRole: "manager",
          timestamp: Date.now(),
        });
      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = activeCustomerCalls[normalizedPhone];
        if (!activeCall || !activeCall.managerSocketId) return;
        io.to(activeCall.managerSocketId).emit("whiteboard:clear", {
          senderId: phone,
          senderRole: "customer",
          timestamp: Date.now(),
        });
      }
    });

    socket.on("whiteboard:undo", (data) => {
      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);
        if (!customerPhone || !activeCustomerCalls[customerPhone]) return;
        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("whiteboard:undo", {
          senderId: email,
          senderRole: "manager",
          timestamp: Date.now(),
        });
      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = activeCustomerCalls[normalizedPhone];
        if (!activeCall || !activeCall.managerSocketId) return;
        io.to(activeCall.managerSocketId).emit("whiteboard:undo", {
          senderId: phone,
          senderRole: "customer",
          timestamp: Date.now(),
        });
      }
    });

    socket.on("whiteboard:toggle", (data) => {
      const { open } = data;
      if (role === "manager") {
        const customerPhone = normalizePhone(socket.user.customerPhone);
        if (!customerPhone || !activeCustomerCalls[customerPhone]) return;
        io.to(activeCustomerCalls[customerPhone].customerSocketId).emit("whiteboard:toggle", {
          open,
          senderId: email,
          senderRole: "manager",
        });
      } else if (role === "customer") {
        const normalizedPhone = normalizePhone(phone);
        const activeCall = activeCustomerCalls[normalizedPhone];
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
        delete activeSupervisors[socketId];
        return;
      }

      console.log(
        `❌ User disconnected: ${socketId} | Role: ${role}` +
        (phone ? ` | Phone: ${phone}` : "") +
        (email ? ` | Email: ${email}` : "")
      );

      if (role === "customer") {
        // Remove from queue if in queue
        const wasInQueue = await removeCustomerFromQueue(phone);
        if (wasInQueue) {
          console.log(`📋 Customer ${phone} removed from queue on disconnect`);
          broadcastQueueAndStatus(io);
        }
        // Auto-stop recording if customer disconnects during call
        const callData = activeCustomerCalls[phone];
        if (callData?.egressId) {
          try {
            const recordingService = require('./recordingService');
            await recordingService.stopRecording(callData.egressId);
            console.log(`🛑 Auto-recording stopped for call ${callData.callRoom} on customer disconnect`);
          } catch (recErr) {
            console.error("⚠️ Failed to auto-stop recording on disconnect:", recErr.message);
          }
        }

        await clearActiveCustomerCall(phone, io);
      } else if (role === "manager") {
        Object.keys(activeCustomerCalls).forEach((customerPhone) => {
          const normalizedPhone = normalizePhone(customerPhone);
          if (
            activeCustomerCalls[normalizedPhone].currentManagerEmail === email
          ) {
            console.log(
              `📣 Notifying customer ${normalizedPhone} about manager ${email} disconnection`
            );
            io.to(activeCustomerCalls[normalizedPhone].customerSocketId).emit(
              "manager:disconnected",
              {
                managerId: email,
                managerName: name || null,
              }
            );
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
    socket.emit("error", { message: error.message });
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
    ) ||
    rejectedManagers[normalizedCustomerPhone]?.has(selectedManager.email)
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

  const roomId = crypto
    .createHash("sha256")
    .update(`${normalizedCustomerPhone}_${selectedManager.email}_${Date.now()}`)
    .digest("hex")
    .slice(0, 16);
  const callRoomLink = `https://${OPENVIDU_DOMAIN}/${roomId}`;

  // Store room ID for OpenVidu/LiveKit (just the ID, not full URL)
  activeCustomerCalls[normalizedCustomerPhone].callRoom = roomId;
  activeCustomerCalls[normalizedCustomerPhone].callRoomLink = callRoomLink;

  const managerSocket = io.sockets.sockets.get(selectedManager.socketId);
  if (managerSocket) {
    managerSocket.user.customerPhone = normalizedCustomerPhone;
  }

  // Fetch customer info from CBS
  const cbsMockService = require("./cbsService");
  let customerInfo = {};
  try {
    const cbsData = await cbsMockService.lookupCustomerByPhone(normalizedCustomerPhone);
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

    const managerSocket = io.sockets.sockets.get(selectedManager.socketId);
    if (managerSocket) {
      managerSocket.emit("call:reassigned", {
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

  delete rejectedManagers[normalizedPhone];
  delete activeCustomerCalls[normalizedPhone];
  console.log(
    `✅ Successfully cleared call state for customer ${normalizedPhone}`
  );
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

  // Check if customer is still connected
  const customerSocket = io.sockets.sockets.get(nextInQueue.socketId);
  if (!customerSocket) {
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
  const cbsMockService = require("./cbsService");
  let customerInfo = {};
  let accountNumber = null;
  try {
    const cbsData = await cbsMockService.lookupCustomerByPhone(nextInQueue.customerPhone);
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

  // BROADCAST: Send call request to all selected managers simultaneously
  for (const manager of selectedManagers) {
    const mgrSocket = io.sockets.sockets.get(manager.socketId);
    if (mgrSocket) {
      // CRITICAL: Do NOT set customerPhone here - only accept handler should set it
      // Setting it during broadcast would overwrite active calls

      // Send call request with verification info
      mgrSocket.emit("call:request", {
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
  customerSocket.emit("queue:call-connecting", {
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
      const mgrSocket = io.sockets.sockets.get(manager.socketId);
      if (mgrSocket) {
        mgrSocket.emit("call:cancelled", {
          customerId: nextInQueue.customerPhone,
          reason: "No response - customer re-queued"
        });
        delete mgrSocket.user.customerPhone;
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
      customerSocket.emit("queue:added", {
        position: result.queuePosition,
        message: "Managers did not respond. You have been placed back in queue with priority.",
        priority: 'HIGH'
      });
    } else {
      customerSocket.emit("call:failed", {
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

module.exports = {
  handleSocketConnection,
  getActiveCallsData,
  getOnlineManagersData
};
