# 第三方依赖许可证清单

本项目自写源码采用 MIT 许可证（见 `LICENSE`）。以下为运行时与开发时
第三方依赖的许可证清单，数据来源：T024 按 `package-lock.json` 安装后的
`node_modules` 各包 `package.json` 的 `license` 字段实测汇总，非手工估算。

注意：本清单只统计许可证标识；各包完整许可证文本以其自身仓库 / 发布包为准。
构建工具链（Vite、Vitest、TypeScript 等）仅用于开发与测试，不随 `dist/`
静态产物一同发布；运行时直接依赖为 React 与 React DOM（均为 MIT）。

共 99 个包（按 package-lock 安装的 node_modules 实测，T024）。
- Apache-2.0：5 个
- BSD-2-Clause：2 个
- BSD-3-Clause：2 个
- BlueOak-1.0.0：1 个
- CC0-1.0：1 个
- ISC：2 个
- MIT：81 个
- MIT-0：2 个
- MPL-2.0：3 个

- @asamuzakjp/css-color@7.1.9 — MIT
- @asamuzakjp/dom-selector@10.0.5 — MIT
- @babel/code-frame@7.29.7 — MIT
- @babel/helper-validator-identifier@7.29.7 — MIT
- @babel/runtime@7.29.10 — MIT
- @bramus/specificity@2.4.3 — MIT
- @csstools/color-helpers@6.1.2 — MIT-0
- @csstools/css-calc@3.4.3 — MIT
- @csstools/css-color-parser@4.2.6 — MIT
- @csstools/css-parser-algorithms@4.0.2 — MIT
- @csstools/css-syntax-patches-for-csstree@1.1.15 — MIT-0
- @csstools/css-tokenizer@4.0.2 — MIT
- @esbuild/linux-x64@0.28.2 — MIT
- @exodus/bytes@1.16.0 — MIT
- @jridgewell/resolve-uri@3.1.2 — MIT
- @jridgewell/sourcemap-codec@1.6.0 — MIT
- @jridgewell/trace-mapping@0.3.31 — MIT
- @oxc-project/types@0.155.0 — MIT
- @rolldown/binding-linux-x64-gnu@1.2.15 — MIT
- @rolldown/binding-linux-x64-musl@1.2.15 — MIT
- @rolldown/pluginutils@1.0.1 — MIT
- @testing-library/dom@10.4.2 — MIT
- @testing-library/react@16.3.3 — MIT
- @testing-library/user-event@14.6.8 — MIT
- @types/aria-query@5.0.4 — MIT
- @types/chai@5.2.3 — MIT
- @types/deep-eql@4.0.2 — MIT
- @types/estree@1.0.9 — MIT
- @types/react-dom@19.3.0 — MIT
- @types/react@19.3.0 — MIT
- @vitejs/plugin-react@6.1.2 — MIT
- @vitest/mocker@5.0.5 — MIT
- @vitest/spy@5.0.5 — MIT
- ansi-regex@5.0.1 — MIT
- ansi-styles@5.2.0 — MIT
- aria-query@5.3.0 — Apache-2.0
- assertion-error@2.0.1 — MIT
- bidi-js@1.1.0 — MIT
- chai@6.3.0 — MIT
- css-tree@3.2.1 — MIT
- csstype@3.2.3 — MIT
- data-urls@8.0.0 — MIT
- decimal.js@10.6.0 — MIT
- dequal@2.0.3 — MIT
- detect-libc@2.1.2 — Apache-2.0
- dom-accessibility-api@0.5.16 — MIT
- entities@8.1.0 — BSD-2-Clause
- es-module-lexer@2.3.2 — MIT
- esbuild@0.28.2 — MIT
- estree-walker@3.0.3 — MIT
- expect-type@1.4.0 — Apache-2.0
- fdir@6.5.0 — MIT
- html-encoding-sniffer@7.0.0 — MIT
- is-potential-custom-element-name@1.0.1 — MIT
- js-tokens@4.0.0 — MIT
- jsdom@30.1.3 — MIT
- lightningcss-linux-x64-gnu@1.33.0 — MPL-2.0
- lightningcss-linux-x64-musl@1.33.0 — MPL-2.0
- lightningcss@1.33.0 — MPL-2.0
- lru-cache@11.5.3 — BlueOak-1.0.0
- lz-string@1.5.0 — MIT
- magic-string@1.4.4 — MIT
- mdn-data@2.27.1 — CC0-1.0
- nanoid@3.3.20 — MIT
- obug@3.0.0 — MIT
- parse5@8.0.1 — MIT
- picocolors@1.1.1 — ISC
- picomatch@4.0.7 — MIT
- postcss@8.5.31 — MIT
- pretty-format@27.5.1 — MIT
- punycode@2.3.1 — MIT
- react-dom@19.3.1 — MIT
- react-is@17.0.2 — MIT
- react@19.3.1 — MIT
- require-from-string@2.0.2 — MIT
- rolldown@1.2.15 — MIT
- saxes@6.0.0 — ISC
- scheduler@0.28.0 — MIT
- source-map-js@1.2.2 — BSD-3-Clause
- std-env@4.3.0 — MIT
- tinybench@6.2.2 — MIT
- tinyexec@1.3.1 — MIT
- tinyglobby@0.2.17 — MIT
- tldts-core@7.4.19 — MIT
- tldts@7.4.19 — MIT
- tough-cookie@6.0.2 — BSD-3-Clause
- tr46@7.0.0 — MIT
- tsx@4.23.15 — MIT
- typescript@5.9.3 — Apache-2.0
- undici@8.12.3 — MIT
- vite@8.3.5 — MIT
- vitest@5.0.5 — MIT
- w3c-xmlserializer@6.0.0 — MIT
- webidl-conversions@8.0.1 — BSD-2-Clause
- whatwg-mimetype@5.0.0 — MIT
- whatwg-url@17.3.0 — MIT
- why-is-node-running@3.2.1 — MIT
- xml-name-validator@5.0.0 — Apache-2.0
- xmlchars@2.2.0 — MIT
