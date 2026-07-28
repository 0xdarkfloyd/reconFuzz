function tag() {}
let n = 65526;
let s = "tag`";
for (let i = 0; i < n; i++) {
  s += "${0}";
}
s += "`";
eval(s);
