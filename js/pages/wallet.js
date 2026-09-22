// js/pages/wallet.js: /wallet is a forwarding page since v2 (SPEC 9.5): the meta refresh in wallet.html sends the
// visitor to /dashboard, the link does the same by hand. This module only boots the shared shell.
import { boot } from './common.js';

boot();
