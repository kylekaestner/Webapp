// Tailwind 3.4.17, default theme, for the standalone public pages (landing, join, manual). Same
// version and settings as the in-browser CDN script they used to load. Built into public/pages.css by
// scripts/build-frontend.js. These pages are hand-written in public/; write class names out in full.
const path = require('path');
const pub = p => path.join(__dirname, '..', 'public', p);
module.exports = {
    content: [pub('landing.html'), pub('join.html'), pub('manual.html')],
};
