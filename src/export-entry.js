// Entry of vendor/export.bundle.js: what the export worker needs and nothing else.
//   @breezystack/lamejs  MP3 encoder (LGPL-3.0, a JavaScript port of LAME)
//   jszip                zip files (MIT or GPL-3.0-or-later)
export { Mp3Encoder } from '@breezystack/lamejs';
export { default as JSZip } from 'jszip';
