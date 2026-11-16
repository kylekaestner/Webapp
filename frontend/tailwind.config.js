// Tailwind 3.4.17, default theme: the same version and settings the old in-browser CDN script ran.
// The build scans the page template and every source file for class names. A class name it can't
// see in full (e.g. `text-${color}-400`) never gets CSS, so always write class names out whole.
const path = require('path');
module.exports = {
    content: [
        path.join(__dirname, 'app.template.html'),
        path.join(__dirname, 'src/**/*.js'),
    ],
};
