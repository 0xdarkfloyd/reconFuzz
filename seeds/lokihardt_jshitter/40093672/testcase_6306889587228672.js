function PI(get, ...gc) {
    while (get++) 
        gc.map(PI);
    return get(97216);
}
PI(97216);
