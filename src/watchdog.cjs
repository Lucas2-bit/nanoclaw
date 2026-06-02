// watchdog.cjs — DEPRECATED / NEUTERED (2026-06-02, Supervisor Split keystone)
//
// This file previously contained pm2 restart logic. It has been neutered as
// part of the MF1/D3 deny-self-lifecycle work. pm2 runs watchdog-v2.cjs only.
// This file is kept to avoid reference errors but has NO operational function.
//
// See: src/watchdog-v2.cjs for the active supervisor.
'use strict';
console.error('[watchdog.cjs] DEPRECATED: this file is neutered. Run watchdog-v2.cjs instead.');
