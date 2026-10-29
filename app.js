'use strict';
// Passenger loads this startup file with require(), so start in both modes.
const { createApplication } = require('./lib/server.cjs');
createApplication().then(({ server }) => {
  server.listen(process.env.PORT || 3000, '127.0.0.1', () => console.log('The Perfect View is running.'));
}).catch(error => { console.error('Startup failed:', error.code || error.message); process.exitCode = 1; });
