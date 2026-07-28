JSON.stringify(0, function (NaN, ...get) {
    return {
        get [get]() {
            function E() {
                get(E());
            }
        },
        get [NaN]() {}
    };
});
