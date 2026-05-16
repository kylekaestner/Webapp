# Crowded Skies - Flight Crew Dispatch System

A server-side flight dispatch and crew scheduling system with database persistence.

## Project Structure

```
.
├── server.js           # Express server with API endpoints
├── db.js               # SQLite database initialization
├── package.json        # Dependencies
├── dispatch.db         # SQLite database (auto-created)
├── public/
│   ├── index.html      # Frontend application
│   └── (static assets)
└── README.md
```

## Database Schema

### Pilots Table
- `id` - Primary key
- `pilot_key` - Unique identifier (kyle, adam, sam, logan)
- `name` - Pilot's full name
- `base` - Home airport code
- `created_at` - Timestamp

### Segments Table
- `id` - Primary key
- `pilot_id` - Foreign key to pilots
- `type` - 'flight', 'hard', or 'away'
- `departure_time` - ISO 8601 datetime
- `arrival_time` - ISO 8601 datetime
- `departure_airport` - ICAO code
- `arrival_airport` - ICAO code
- `tail` - Aircraft tail number
- `trip` - Trip number
- `flight_number` - Flight identifier
- `is_dh` - Boolean, whether this is a deadhead flight

## Setup Instructions

### 1. Install Dependencies

```bash
cd e:\Webapp
npm install
```

### 2. Start the Server

```bash
npm start
```

The server will start on `http://localhost:3000` and automatically:
- Initialize the SQLite database at `dispatch.db`
- Create the required tables
- Seed the pilots table with initial crew data

### 3. Access the Application

Open your browser to `http://localhost:3000`

## API Endpoints

### Get All Pilots
```
GET /api/pilots
```
Returns array of all pilots.

### Get Pilot with Segments
```
GET /api/pilots/:pilotKey
```
Returns pilot details and their schedule segments. Example:
```
GET /api/pilots/kyle
```

### Upload Schedule File
```
POST /api/pilots/:pilotKey/upload
Content-Type: multipart/form-data

Form data:
- file: ICS or CSV file
```

Supported formats:
- **ICS (iCalendar)**: Schedaero format
- **CSV**: Standard flight schedule CSV with headers

Response:
```json
{
  "success": true,
  "segmentsAdded": 24
}
```

### Get Segments by Criteria
```
GET /api/segments?pilotKey=kyle&startDate=2026-05-01&endDate=2026-05-31
```

### Delete Pilot's Segments
```
DELETE /api/pilots/:pilotKey/segments
```

### Health Check
```
GET /api/health
```

## File Upload Formats

The system automatically detects which parser to use based on the pilot:

### Kyle (ICS Format - Schedaero)
- **File type**: `.ics` (iCalendar)
- **Parser**: ICS
- Example event:
```
BEGIN:VEVENT
UID:12345
DTSTART:20260505T143600Z
DTEND:20260505T184200Z
SUMMARY:✈️ KSUS -> TJSJ
DESCRIPTION:Tail: N431JD\nTrip: 501826
END:VEVENT
```

### Adam & Sam (CSV Format - Standard)
- **File type**: `.csv`
- **Parser**: Standard CSV
- **Required columns**: DATE, DEP, ARR, DEPTIME, ARRTIME
- **Optional columns**: TAIL, DH, FCVTAIL, TRIP
- Example:
```
DATE,DEP,ARR,DEPTIME,ARRTIME,TAIL,DH
05/05/2026,KSUS,TJSJ,14:36,18:42,N431JD,0
```

### Logan (CSV Format - SkyWest Variant)
- **File type**: `.csv`
- **Parser**: SkyWest (flexible header names)
- **Flexible headers**: Supports DATE|FLIGHTDATE|SCHEDULEDATE, DEP|DEPARTURE|ORIG, ARR|ARRIVAL|DEST, DEPTIME|DEP_TIME|DEPARTURETIME, ARRTIME|ARR_TIME|ARRIVALTIME, TAIL|AIRCRAFT|REGISTRATION, DH|DUTY|IS_DH
- **Example columns (any of these work)**:
```
FLIGHTDATE,DEPARTURE,DESTINATION,DEP_TIME,ARR_TIME,AIRCRAFT,DH
```

## Features

### Views
- **Calendar Grid**: Monthly view of all segments with color coding
- **List View**: Chronological list of events with details
- **Route Map**: Interactive map showing flight routes with great circle arcs

### Crew Management
- Track 4 pilots (Kyle, Adam, Sam, Logan)
- Support for multiple schedule types (flights, hard days off, away periods)
- Layover calculations
- Deadhead flight tracking

### Schedule Analysis
- Day-past opacity for historical events
- Current day highlighting
- Trip blocking by event type
- Layover duration display

## Development

### Database Reset
To reset the database and start fresh:
```bash
rm dispatch.db
npm start
```

### Run in Development Mode
```bash
npm run dev
```
Uses nodemon for auto-restart on file changes.

### Parser Configuration
Edit the `pilotParsers` object in `server.js` to change which parser is used for each pilot:

```javascript
const pilotParsers = {
    kyle: 'ics',           // Uses parseICS()
    adam: 'csv',           // Uses parseCSV() (standard)
    sam: 'csv',            // Uses parseCSV() (standard)
    logan: 'csv_skywest'   // Uses parseCSV_skywest() (flexible headers)
};
```

## Data Model Notes

**Segments** represent individual events in a pilot's schedule:
- **Flight**: A revenue flight segment with departure/arrival airports and times
- **Hard**: A full day off where the pilot is not available
- **Away**: A layover period at a non-home airport between flights

**Inference**: The system automatically infers away layovers between consecutive flights when a pilot is away from their home base.

## Browser Compatibility

- Modern browsers with ES6 support
- Requires JavaScript enabled
- Tested on Chrome, Firefox, Safari, Edge

## Troubleshooting

### Database locked errors
Ensure only one server instance is running.

### File upload fails
- Check file format (must be .ics or .csv)
- Verify file is readable by the server
- Check server logs for parsing errors

### No data showing
1. Verify pilot exists: `GET /api/pilots`
2. Verify segments exist: `GET /api/segments?pilotKey=kyle`
3. Check browser console for API errors
4. Restart server to reinitialize database
