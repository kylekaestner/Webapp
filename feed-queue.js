// Paced processing for the FAA SWIM feeds (swim.js / stdds.js / tfms.js / tfdm.js).
//
// Each feed used to parse every message synchronously the moment Solace delivered it, then ack it
// immediately -- which tells the broker to send the next one right away. Fine live, but after a
// restart the queues deliver their whole backlog back to back: the server was listening 4.5s after
// boot yet didn't answer HTTP until ~90s (2026-11-03), because the event loop never got a turn.
//
// Now messages are queued and processed a small batch per event-loop turn (setImmediate between
// batches, so HTTP requests interleave), and each one is acknowledged only after it's handled.
//
// Acknowledging late does NOT slow the broker down. Its window is maxWindowSize minus what's waiting
// inside the Solace library, and this queue takes every message the moment it arrives, so the window
// stays wide open. An unbounded queue held 14,000+ messages after a restart: each kill left a bigger
// backlog, so the next boot died sooner (2026-11-03, four kills in six minutes). So the consumer is
// paused above HIGH_WATER. stop() keeps messages in the library, the window closes, and the backlog
// waits at the broker instead of in this droplet's 1 GB.
const BATCH = 20;
const HIGH_WATER = 300;
const LOW_WATER = 50;
const _queues = {}; // label -> queue, for the server's memory log
function getFeedDepths() { return Object.fromEntries(Object.entries(_queues).map(([k, q]) => [k, q.length])); }

function createFeedQueue(label, handle, onError, consumer) {
    const queue = [];
    _queues[label] = queue;
    let scheduled = false;
    let paused = false;
    // Throws if the consumer has gone down. A reconnect makes a new consumer and a new queue.
    const pause = () => { try { consumer?.stop(); paused = true; } catch (_) {} };
    const resume = () => { try { consumer?.start(); } catch (_) {} paused = false; };
    function drain() {
        scheduled = false;
        for (let i = 0; i < BATCH && queue.length; i++) {
            const message = queue.shift();
            try {
                const xmlText = message.getXmlContent();
                if (xmlText) handle(xmlText);
            } catch (e) {
                if (onError) onError(e);
            } finally {
                try { message.acknowledge(); } catch (_) {}
            }
        }
        if (paused && queue.length <= LOW_WATER) resume();
        if (queue.length) { scheduled = true; setImmediate(drain); }
    }
    return function enqueue(message) {
        queue.push(message);
        if (!paused && queue.length >= HIGH_WATER) pause();
        if (!scheduled) { scheduled = true; setImmediate(drain); }
    };
}

module.exports = { createFeedQueue, getFeedDepths };
