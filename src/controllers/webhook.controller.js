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

        // Verify and decode webhook event
        // Note: req.body must be the raw body if signature verification is needed, 
        // but in most internal setups with trusted networks, we can use the parsed body.
        // The livekit-server-sdk WebhookReceiver.receive expects the raw body and headers.
        const event = receiver.receive(req.body, req.get('Authorization'));

        console.log(`🔌 LiveKit Webhook received: ${event.event}`, {
            egressId: event.egressInfo?.egressId,
            roomName: event.room?.name || event.egressInfo?.roomName,
            status: event.egressInfo?.status
        });

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
