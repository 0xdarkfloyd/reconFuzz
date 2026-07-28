// Flags: --trace-regexp-assembler --regexp-simd
const re = /[aA].{3}[bB].{3}[cCeEfF]/;
const subject = "A".repeat(1000);
re.test(subject);
