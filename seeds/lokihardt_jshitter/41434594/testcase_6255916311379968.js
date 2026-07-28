const E = '"use asm";\nfunction f() { LOCALS }\nreturn f;', PI = new Function(E.replace(';', ' '));
