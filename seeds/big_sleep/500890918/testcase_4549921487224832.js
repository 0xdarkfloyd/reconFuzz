if (arguments.length > 0 && arguments[0].includes("input")) {
    let i = 0;
    while(i < 1000000) i++;
} else {
    Promise.reject();
}