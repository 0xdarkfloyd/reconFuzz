var get = this;
var PI = new Proxy(get, {
    get() {
        PI();
    }
});
var PI = new gc(PI, {
});