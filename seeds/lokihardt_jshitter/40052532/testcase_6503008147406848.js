var set = this;
;
for (set in map)
    ;
var map = new Function(set.replace('LOCALS', Array(50000).fill().map((set, map) => ('var l' + map) + ' = 0;').join('')));
