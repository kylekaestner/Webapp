~~Leaflet has 2 tone map. Dark and grey blue~~ (CARTO restyle, basemap tinted 11/3)
~~app is still a bit laggy. refresh page can't click on anything for a few seconds.~~ (fixed 11/3: Crossings startup work 64x faster, one request per pilot)
~~Map takes a few seconds to respond/load data.~~ (fixed 11/3: 0.53s on phone, admin)
MAcks e38-okc flight had wrong transition data in for runway in use -- STILL OPEN 11/3: removed a runway borrowed from another leg, not confirmed. Check the next arrival against the runway in use.
~~Mack and James were showing the live green on the grid/list after landing. James had 200ft, 117 knots. Mack had no data. Potenital park flag not working. Mack on the map said "on ground" e38-okc was dashed like it was live. James was thinking his next flight was live CQF-HOT and also had the route for HOT-CLT showing. Still haven't fixed the bug if the 2nd leg down the line FP comes in to store and and not display it until its relevant. James actually had 2 dashed lines coming out one for the HOT route and one for CLT route~~ (fixed 11/3: per-leg state and routes, watch the next few landings)

KCQF → HOTJames · EJA492
03:06 PM CT – 04:12 PM CT · 1h 6m · N492QS --- applying to HOT-CLT which isn't airbone yet!!
~~✓ LANDED EARLY --- doesn't make sense.~~ (fixed 11/3: NetJets legs are never marked landed early)

~~If the day is active on grid and the next/current flight requires the grid cell to be scrolled...auto scroll it to the relevant leg.~~ (done 11/3)
~~James HOT-CLT doesn't show any route~~ (fixed 11/3: ADS-B failure was dropping the filed route)