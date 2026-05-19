- ~~Add flight button to mobile~~
- ~~Edit/delete flights manually added~~
- ~~Day of map option. Basically show where all users are flying that day.~~
- ~~Location Overlap calculator. Figure out if any of the users will be in the same general location based on their schedules.~~
- ~~Block times inaccurate based on timezones. (Logan) Shows longer flights due to the time difference. I think his csv includs 'block' time.~~
- ~~If the current flight is live. Make the line green~~
- ~~Legends for the map/calendar?~~
- ~~Add the curving on the normal route maps too for turns. Maybe for live flights add some animation to the line. Also doesn't hurt to experiment with an airplane icon if they're in the air, and the dot if they're at an airport/home.~~
- ~~Scroll the current day or next available overlap to the top of the list on location overlap~~
- ~~Rework Location overlap to make it easier to understand. I want to be able to see very easily if I'll be in the same location as someone, etc.~~
- ~~Make sure overlap isn't showing when they're 'OFF' because if they end a trip in LGA they are most likely commuting home instead of staying there.~~
- ~~Pilot may have in base layovers that aren't their home. Make sure the layover tag and time is included on those. I most commonly see those on Adam's and Sam's schedule at LGA.~~
- ~~Get rid of the buffer selection. That should just be a reasonable amount of time.~~
- ~~Some schedules are showing really long layovers next to 'OFF' days. This would just be the end of the trip and we can assume they'd commute home. (No layover shown at home base if gap > 30h)~~
~~If a calendar box says on call, and i click on it the popup should say day off.~~
~~Make sync schedaero only appear when Kyle is reselected. Make the button pretty invisible to other users as it's only for Kyle.~~
~~Some of the times are incorrect on April for Kyle. May be time zone issues or the way the data was pulled.~~
~~Location overlap has a 67hr overlap for Adam and Sam. This isn't right. The more likely scenario is they ended their trip at their base LGA. If they ended their trip and are OFF the next day it's safe to assume they left LGA and commuted home. We just don't have the commute info unless the user adds is manually.~~
~~For location overlap perhaps take into account city area. For example, Kyle, flies corporate jets who will frequent smaller airports in large cities, but another user may be at the big airport. Can we make a way to filter a radius. Adam may be on a layover at LGA and Kyle is on a TEB layover in New Jersey, but that airport servers the create NYC Area.~~
~~Adsb lines smoothing. Sometimes appears jagged.~~
~~Today map has both the live line with Adsb and a green arc. So the flight is doubled on the map. Get rid of thick lines. Make another way to show it live.~~
~~When a live flight is active draw the arc is a predictive manner so it follows direction of travel.~~
~~Here now needs to be adjusted. Should be located at last airport, unless there’s a live flight, or off day.~~
~~For Kyle, autofil last used schedaero sync creditionals.~~ 
~~Let's add detail to the mobile calendar grid.~~ 
~~Mobile Map menu on bottom is messed up with the legend. Make top rght filters smaller for Mobile.~~
~~Overlap improvements: metro area groupings (TEB/LGA/EWR=NYC, SUS/STL=STL), type badges (Layover/Passing Through/Home Turf/Meetup/Nearby/Same Flight), duration bar, "Your Upcoming Crossings" summary panel, home visit annotation.~~
-Look at people's apple calendars for flights added by airline apps. AKA southwest flights, etc. Would mostly be for personal, commuting, and DHs.
~~Drew ICS subscription sync — RosterBuster ICS URL stored, sync button visible when Drew selected.~~
~~Location meetup thinks Adam is staying at ORD longer than he is. Don't just leave the user at their last destination for a set amount of time. He would most likely add a commute to go home in there. ADam is home 27, 28th, until he starts his next trip in LGA the 29th. This is messing up location overlap. He should manually add a commute to get to LGA to make it more accurate, but those happen a day prior or day of.~~
~~All Crew - Month view, Day on top (sidebar + mobile bar)~~
~~All crew -day view doesn't show flight with live data if it's airborne.~~
~~Calendar doesn't start with sunday.~~
~~Mobile map clicking better, clicking on all crew month has boxes showing up on desktop.~~
~~All crew Legend should be clickable to toggle off people.~~
~~mobile - when added to home on iphone as webapp, make the app refresh itself automatically.~~
~~Kyle has a layover duration for KSUS.~~
~~If a flight was live, but the ETA time past, and the aircraft is airborne (ADSB), continue showing the flight until it lands. Then update the time it landed. Same if a flight lands early. Marked the flight as no longer live/landed. Flight for Adam is showing live bc it hasn't reach the arrival time in CT but it has in ET. So it should've already landed.~~
-Maybe for personal/DH manual add they can just put the flight number in and airport pair and it'll figure out the rest?
-Overlap could have a small inset map of the airport/location
~~Find a way to keep the session cookie active. Make it easier to sync on mobile bc safari doesn't have DevTools~~
~~Changing crew selection while on location overlap should automatically refresh.~~
~~Look to optimize mobile. Help tooltip cut off my iphone dynamic island. Add help buttons to each page on mobile.~~
~~Modal add flight tail and flight # fields overlapping~~
~~I think a 6 hour window may be too long for location overlap. Near misses may need to be minimized a bit so they aren't too cluttering. Again we want to emphasize good and realistic chances to meet up.~~ 
~~Maybe a new feature that shows common off days by users for planning things outside of flying.~~
