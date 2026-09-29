// Exit 0 when a UiPath credential is available (PAT, or client ID + secret); otherwise exit 2.
// start-local.bat / start-local.sh use it to ask for the token at run time, so the token
// does not have to be stored in .env. Never prints any value.
const env = process.env;
const hasPat = Boolean(env.UIPATH_PAT);
const hasClient = Boolean(env.UIPATH_CLIENT_ID && env.UIPATH_CLIENT_SECRET);
process.exit(hasPat || hasClient ? 0 : 2);
