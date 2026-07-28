let s1 = "a".repeat(1000);
let s2 = "b".repeat(1000);
let subject = s1 + s2;

let re = /[a]/g;
re.lastIndex = 3000;
re.exec(subject);