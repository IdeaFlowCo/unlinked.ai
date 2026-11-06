// Preload (`node --import`) that installs the public index worker host, so a
// reader test file runs every cacheable reader through the worker
// (index-host.mjs). `npm run test:index-worker` runs the reader suites this way.
import { createPublicIndexHost, installPublicIndexHost } from '../../src/utils/public-people/index-host.mjs'
installPublicIndexHost(createPublicIndexHost())
