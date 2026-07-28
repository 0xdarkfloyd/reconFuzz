let regexes = [
  /(?:[^a][\s\S])*/s
];
for (let re of regexes) {
    re.exec();
    re.exec();
}