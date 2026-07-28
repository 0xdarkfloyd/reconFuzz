// Flags: --validate-asm
var args = [];
for (var i = 0; i < 10000; i++) {
    args.push("1.0");
}
var src = 'function Module(stdlib) {\n' +
          '  "use asm";\n' +
          '  var min = stdlib.Math.min;\n' +
          '  function f() {\n' +
          '    return +min(' + args.join(',') + ');\n' +
          '  }\n' +
          '  return { f: f };\n' +
          '}';
try {
    var m = eval('(' + src + ')')(this);
    console.log("Success");
} catch (e) {
    console.log("Error: " + e);
}
