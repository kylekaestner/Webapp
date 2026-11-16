        // ── Map libraries, loaded on first use ──────────────────────────────────
        // Leaflet 1.9.4, MapLibre GL 4.7.1 and the Leaflet-MapLibre bridge (~950 KB to download and parse)
        // used to load on every launch. They load the first time a map is shown instead. Only three
        // functions start a map: initMap() (Map tab), renderIntelMap() (Crew Intel) and
        // _initWrappedRouteMap() (Wrapped). Each waits here first. Every other map function (renderMap,
        // renderDayMap, live tracking, pins) does nothing until initMap() has created `map`.
        // The CSS goes in before the page's own <style>, where it always was, so the app's overrides of
        // Leaflet's popups and attribution still win. MapLibre is optional: if it fails, _canDrawVectorMap()
        // falls back to raster tiles, as it did when MapLibre (then `defer`) hadn't loaded yet.
        var _mapLibsPromise = null;
        function _mapLibsReady() { return !!(window.L && window.L.map); }
        // quiet: the background warm-up below; a failure there shows nothing (a real map open retries and says so).
        function ensureMapLibs(quiet = false) {
            if (_mapLibsPromise) return _mapLibsPromise;
            const before = document.head.querySelector('style');
            const css = href => new Promise(done => {
                const l = document.createElement('link');
                l.rel = 'stylesheet'; l.href = href;
                l.onload = l.onerror = () => done();
                document.head.insertBefore(l, before);
            });
            const js = src => new Promise((ok, fail) => {
                const s = document.createElement('script');
                s.src = src; s.async = false;
                s.onload = () => ok();
                s.onerror = () => fail(new Error('could not load ' + src));
                document.head.appendChild(s);
            });
            _mapLibsPromise = Promise.all([
                css('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'),
                css('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'),
                js('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'),
            ]).then(() => js('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js')
                .then(() => js('https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js'))
                .catch(e => console.warn('[map] vector basemap unavailable, using raster tiles:', e.message))
            ).catch(e => {
                _mapLibsPromise = null; // let the next map open try again
                if (!quiet) showToast('Map could not load. Check your connection and try again.', 'error', 4000);
                throw e;
            });
            return _mapLibsPromise;
        }
        // Warm-up: once the app has drawn and the browser is idle, load the map libraries in the background,
        // so the first map open doesn't wait for them (the map already took a moment to pop in before they
        // moved out of the page). Skipped on data-saver connections; those load on first map open.
        window.addEventListener('load', () => setTimeout(() => {
            if (navigator.connection && navigator.connection.saveData) return;
            (window.requestIdleCallback || (cb => cb()))(() => ensureMapLibs(true).then(_prewarmMap).catch(() => {}), { timeout: 4000 });
        }, 1500));
        // The first Map open was slow even with the libraries loaded (~1.2 s in Chrome, then ~10 ms on every
        // later open): creating the map, the vector basemap's style, fonts and first tiles. So after the
        // warm-up the map is also created ahead of time, full size but off-screen and invisible
        // (#view-map.map-prewarm), and left to load. That's the same state as having opened Map once and
        // gone back to the calendar. switchView('map') drops the class and resizes the map to its real box.
        function _prewarmMap() {
            if (map || currentView === 'map' || !_mapLibsReady()) return;
            const view = document.getElementById('view-map');
            if (!view) return;
            view.classList.add('map-prewarm');
            try { initMap(); } catch (e) { view.classList.remove('map-prewarm'); console.warn('[map] prewarm failed:', e.message); return; }
            const gl = ((_basemapMaps.find(b => b.map === map) || {}).layers || []).map(l => l.getMaplibreMap?.()).find(Boolean);
            const finish = () => view.classList.remove('map-prewarm');
            if (gl) { const t = setTimeout(finish, 10000); gl.once('idle', () => { clearTimeout(t); finish(); }); }
            else setTimeout(finish, 3000);
        }

        function initMap() {
            if (map) return;
            if (!_mapLibsReady()) {
                ensureMapLibs().then(() => { if (currentView === 'map') { initMap(); render(); } }).catch(() => {});
                return;
            }
            map = L.map('map', { zoomControl: false, doubleClickZoom: true, bounceAtZoomLimits: false }).setView([39.8283, -98.5795], 4);
            addBasemap(map);
            map.attributionControl.setPrefix(false);
            // Scrolling/swiping the pilot legend shouldn't pan or zoom the map underneath it
            const _legendScroll = document.getElementById('legend-day-pilots');
            if (_legendScroll) { L.DomEvent.disableScrollPropagation(_legendScroll); L.DomEvent.disableClickPropagation(_legendScroll); }
            setupDoubleTapZoom(map);
            map.on('zoomend', deoverlapLiveLabels);
            map.on('moveend', deoverlapLiveLabels);
            map.on('zoomend', applyRouteDetailZoomTier);
        }

        function toRadians(deg) { return deg * Math.PI / 180; }
        function toDegrees(rad) { return rad * 180 / Math.PI; }
        function greatCircleArcCoords(start, end, steps = 64) {
            const [lat1, lon1] = start.map(toRadians);
            const [lat2, lon2] = end.map(toRadians);
            const dLon = lon2 - lon1;
            const cosDelta = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLon);
            const delta = Math.acos(Math.min(1, Math.max(-1, cosDelta)));
            if (delta === 0) return [[start[0], start[1]], [end[0], end[1]]];
            const path = [];
            for (let i = 0; i <= steps; i++) {
                const f = i / steps;
                const A = Math.sin((1 - f) * delta) / Math.sin(delta);
                const B = Math.sin(f * delta) / Math.sin(delta);
                const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
                const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
                const z = A * Math.sin(lat1) + B * Math.sin(lat2);
                const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
                const lon = Math.atan2(y, x);
                path.push([toDegrees(lat), toDegrees(lon)]);
            }
            return path;
        }

        // Unwrap longitudes so they stay continuous across the antimeridian.
        // When a step jumps > 180° Leaflet wraps it — instead we let lon exceed
        // ±180 so Leaflet renders a single unbroken arc over the Pacific.
        function unwrapLongitudes(coords) {
            if (!coords || coords.length < 2) return coords || [];
            const result = [[coords[0][0], coords[0][1]]];
            for (let i = 1; i < coords.length; i++) {
                let lat = coords[i][0];
                let lon = coords[i][1];
                const prevLon = result[i - 1][1];
                while (lon - prevLon >  180) lon -= 360;
                while (prevLon - lon >  180) lon += 360;
                result.push([lat, lon]);
            }
            return result;
        }

        // How far before scheduled departure the planned/filed route (symbols + line, via
        // startLiveTracking's preflight branch) starts showing, instead of just the plain
        // scheduled arc -- requested directly, deliberately short so a flight hours or days out
        // doesn't show "all the route BS" (verbatim), only one genuinely about to depart.
        const PREFLIGHT_ROUTE_MS = 30 * 60 * 1000;
        // Pre-departure window, including a short grace after scheduled departure while the aircraft
        // is still at the gate or pushing back (no live position yet, so it isn't airborne).
        // Stays open after scheduled departure for as long as the flight hasn't been seen flying: an aircraft
        // still at the gate or pushing back late keeps its planned route, until it's airborne or the arrival passes.
        const PREFLIGHT_LATE_MS = 3 * 60 * 60 * 1000;
        const isPreflightWindow = (d, nowMs, arrMs) => !!d && (d - nowMs) <= PREFLIGHT_ROUTE_MS && (nowMs - d) < PREFLIGHT_LATE_MS && (!arrMs || nowMs < arrMs);

        // Render a polyline on the primary world copy plus ±360°/±720° copies so it
        // appears on every world copy as the user pans east or west.
        const WORLD_OFFSETS = [-2, -1, 0, 1, 2];
        function worldLines(coords, opts) {
            return WORLD_OFFSETS.map(w => L.polyline(coords.map(([la, lo]) => [la, lo + w * 360]), opts));
        }
        function worldDots(ll, opts) {
            return WORLD_OFFSETS.map(w => L.circleMarker([ll[0], ll[1] + w * 360], opts));
        }
        function worldLabels(ll, iconHtml) {
            return WORLD_OFFSETS.map(w => L.marker([ll[0], ll[1] + w * 360], {
                icon: L.divIcon({ className: '', html: iconHtml, iconAnchor: [0, 0] }),
                interactive: false
            }));
        }
        // Creates one plane-icon marker per world copy, all added to map.
        // Primary copy (w=0) is at index 2. Bind tooltip to [2] only.
        function worldPlaneMarkers(pos, icon) {
            return WORLD_OFFSETS.map(w => {
                const m = L.marker([pos[0], pos[1] + w * 360], { icon, zIndexOffset: 1000 });
                m.addTo(map);
                return m;
            });
        }

