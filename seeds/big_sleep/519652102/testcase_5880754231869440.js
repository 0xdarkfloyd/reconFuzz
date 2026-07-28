// Flags: --stress-lazy-source-positions

(function f() {
  {
    let force_block_scope;
    eval(`
      {
        function f() {}
      }
      var g = (function g() { f(); })
    `);
  }
})();