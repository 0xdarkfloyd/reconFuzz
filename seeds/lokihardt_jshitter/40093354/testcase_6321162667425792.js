function* E(E) {
    for (;;)
        for (yield* -125; E; yield* 9) {
            for (yield* -125; E; yield* 9) {}
        }
    yield* 0;
}
throw E(%OptimizeFunctionOnNextCall(E));
