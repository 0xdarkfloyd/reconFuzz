// Flags: --enable-experimental-regexp-engine-on-excessive-backtracks --regexp-backtracks-before-fallback=3000000000

let re = /(a|a)*b/;
re.test("a");
