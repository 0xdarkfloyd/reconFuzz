var PI = PI;
for (E = 0; E < 65586; E++)
    PI +=E % 321 + String.fromCharCode(E) + '|';
new RegExp(PI).exec(PI);