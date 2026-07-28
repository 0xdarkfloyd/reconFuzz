let n = 1.1;
Sandbox.markForCorruptionOnAccess(n, 4);
Sandbox.markForCorruptionOnAccess(n, 8);
let x = n + 1;