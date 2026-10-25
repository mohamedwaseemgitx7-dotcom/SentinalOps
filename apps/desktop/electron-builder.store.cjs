// Microsoft Store (MSIX/AppX) build. The Store signs the package with a Microsoft certificate,
// which is the ₹0 route to a trusted, SmartScreen-friendly install for individual developers.
//
// Values come from Partner Center → your app → Product identity (free individual account):
//   STORE_IDENTITY_NAME            e.g. 12345MohamedWaseem.SentinelOps
//   STORE_PUBLISHER                e.g. CN=11111111-2222-3333-4444-555555555555
//   STORE_PUBLISHER_DISPLAY_NAME   e.g. Mohamed Waseem
// Run: npm run dist:store -w @sentinelops/desktop   → upload release/*.appx in Partner Center.
const base = require('./package.json').build;

const required = ['STORE_IDENTITY_NAME', 'STORE_PUBLISHER', 'STORE_PUBLISHER_DISPLAY_NAME'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(`Missing ${missing.join(', ')}. Copy them from Partner Center → Product identity (see BUILD_WINDOWS.md).`);
}

module.exports = {
  ...base,
  appx: {
    identityName: process.env.STORE_IDENTITY_NAME,
    publisher: process.env.STORE_PUBLISHER,
    publisherDisplayName: process.env.STORE_PUBLISHER_DISPLAY_NAME,
    applicationId: 'SentinelOps',
    displayName: 'SentinelOps',
    backgroundColor: '#0a1120',
    languages: ['en-US'],
    // runFullTrust is required for Electron desktop apps packaged as MSIX.
    capabilities: ['runFullTrust', 'internetClient'],
  },
};
