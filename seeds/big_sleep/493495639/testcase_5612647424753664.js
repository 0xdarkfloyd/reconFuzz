// Flags: --icu-data-file=/dev/null
try {
  new Intl.Segmenter();
} catch (e) {
  print(e);
}
