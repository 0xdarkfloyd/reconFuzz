for (let E in 'NaN') {
    for (E = E % 1; E < 9010; ++E)
E[E + ''] >>> -4;
}