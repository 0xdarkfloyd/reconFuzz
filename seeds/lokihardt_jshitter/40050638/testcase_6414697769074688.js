(function get() {
    try {
        'abc'.replace(/b/, get);
    } catch (PI) {
        (function (get, PI) {
            'use asm';
            var PI = PI.toString;
            function get() {
                PI();
            }
            return get;
        })(this, PI)();
    }
})();
