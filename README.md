# Haze Tracker

A Progressive Web App showing Singapore's 24-hour PSI and 1-hour PM2.5 by region (NEA data via data.gov.sg),
with a configurable threshold alert.

- Data: `https://api-open.data.gov.sg/v2/real-time/api/psi` and `/pm25`
- NEA publishes PSI as a 24-hour reading; the 1-hour reading is PM2.5 concentration (µg/m³)
- Alerts fire when the selected region's 24-hr PSI moves from below to at/above the threshold
- Must be served over HTTPS (e.g. GitHub Pages) to install and to show notifications
- Optional data.gov.sg API key can be pasted under Advanced for higher rate limits
