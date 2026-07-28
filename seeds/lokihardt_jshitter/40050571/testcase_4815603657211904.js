Object.setPrototypeOf(this, new Proxy({
    get PI() {
        (function get(__v_1, get) {
            'use asm';
            var __v_5 = get.constructor, __v_0 = get.call;
            function get() {
                __v_5(__v_5(__v_5() | 0, __v_5(__v_5() | 0) | 0) | 0, __v_5() | 0, __v_5(__v_5(__v_5() | 0, __v_5(9) | 0, __v_5() | 0) | 0) | 0);
            }
            return get;
        });
        typeof PI;
    }
}, {}));
PI.PI;
