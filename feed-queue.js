// Paced processing for the FAA SWIM feeds (swim.js / stdds.js / tfms.js / tfdm.js).
//
// Each feed used to parse every message synchronously the moment Solace delivered it, then ack it
// immediately -- which tells the broker to send the next one right away. Fine live, but after a
// restart the queues deliver their whole backlog back to back: the server was listening 4.5s after
// boot yet didn't answer HTTP until ~90s (2026-11-03), because the event loop never got a turn.
//
// Now messages are queued and processed a small batch per event-loop turn (setImmediate between
// batches, so HTTP requests interleave), and each one is acknowledged only after it's handled.
// With CLIENT acknowledgement the broker keeps at most its window of unacked messages in flight,
// so the backlog drains at the rate we actually process it instead of flooding memory.
const BATCH = 20;
const _queues = {}; // label -> queue, for the server's memory log
function getFeedDepths() { return Object.fromEntries(Object.entries(_queues).map(([k, q]) => [k, q.length])); }

function createFeedQueue(label, handle, onError) {
    const queue = [];
    _queues[label] = queue;
    let scheduled = false;
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
        if (queue.length) { scheduled = true; setImmediate(drain); }
    }
    return function enqueue(message) {
        queue.push(message);
        if (!scheduled) { scheduled = true; setImmediate(drain); }
    };
}

module.exports = { createFeedQueue, getFeedDepths };
