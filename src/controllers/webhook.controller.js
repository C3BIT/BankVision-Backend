const { WebhookReceiver } = require('livekit-server-sdk');
const recordingService = require('../services/recordingService');
const { Recording } = require('../models');

/**
 * Handle LiveKit webhooks
 * POST /api/webhook/livekit
 */
const handleLiveKitWebhook = async (req, res) => {
    try {
        const receiver = new WebhookReceiver(
            process.env.LIVEKIT_API_KEY,
            process.env.LIVEKIT_API_SECRET
        );

        // WebhookReceiver.receive() hashes the exact raw bytes LiveKit signed -
        // req.rawBody is stashed by the express.json() verify callback in index.js
        // specifically so this doesn't have to re-serialize the parsed req.body
        // (which wouldn't byte-for-byte match what was actually signed).
        const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
        const event = await receiver.receive(rawBody, req.get('Authorization'));

        console.log(`🔌 LiveKit Webhook received: ${event.event}`, {
            egressId: event.egressInfo?.egressId,
            roomName: event.room?.name || event.egressInfo?.roomName,
            status: event.egressInfo?.status
        });

        // Call truly ended (LiveKit only fires this when the room actually
        // closes — never on a transient reconnect). Revoke the customer's
        // session so a leftover/copied token can't start a NEW call as them
        // after the call is over (closes the post-call token-reuse window).
        if (event.event === 'room_finished') {
            const roomName = event.room?.name || '';
            // Rooms are named room_<customerPhone>_<timestamp> (socketHandler).
            const m = String(roomName).match(/^room_(\d+)_/);
            if (m) {
                try {
                    const { getCustomerSessions } = require('../utils/customerSession');
                    const revoked = await getCustomerSessions().revokeByPhone(m[1]);
                    console.log(`🔒 room_finished ${roomName} → customer session revoked for ${m[1]}: ${revoked}`);
                } catch (err) {
                    console.error(`⚠️ room_finished session revoke failed for ${roomName}:`, err.message);
                }
            }
        }

        // Handle Egress events
        if (event.event === 'egress_started') {
            const { egressId, roomName } = event.egressInfo;
            console.log(`🎬 Egress started: ${egressId} for room ${roomName}`);

            // Ensure we have a record in DB (might already exist if we started it via API)
            const [recording, created] = await Recording.findOrCreate({
                where: { egressId },
                defaults: {
                    callRoom: roomName,
                    status: 'recording',
                    startTime: new Date(),
                    customerPhone: 'unknown',
                    managerEmail: 'unknown'
                }
            });

            if (!created && recording.status !== 'recording') {
                await recording.update({ status: 'recording' });
            }
        }
        else if (event.event === 'egress_ended') {
            const { egressId, status } = event.egressInfo;
            console.log(`🛑 Egress ended: ${egressId} with status ${status}`);

            // status 3 is COMPLETED, status 4 is FAILED
            if (status === 3 || status === 4) {
                // Trigger finalization logic in recording service
                // This will fetch final file info and update DB
                try {
                    await recordingService.getRecordingStatus(egressId);
                    console.log(`✅ Recording ${egressId} finalized via webhook`);
                } catch (err) {
                    console.error(`❌ Failed to finalize recording ${egressId} from webhook:`, err.message);
                }
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ LiveKit Webhook Error:', error.message);
        // Always return 200 to LiveKit to avoid retries if the error is on our side processing it
        res.status(200).send('Error but acknowledged');
    }
};

module.exports = {
    handleLiveKitWebhook
};
