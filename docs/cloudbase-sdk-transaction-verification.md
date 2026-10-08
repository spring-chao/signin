# CloudBase 事务调用核验

2026-10-08仅核验公开发布包及隔离执行，没有真实CloudBase数据库调用。

`cloudfunc/package.json` 从浮动范围锁为 `@cloudbase/node-sdk@3.18.3`，提交 package-lock.json。该官方包精确依赖 `@cloudbase/database@1.4.3`。本地使用 `npm ci --ignore-scripts --no-audit --no-fund` 安装锁定公开依赖；CI重复安装相同lock后执行 `tests/cloudbase_sdk_contract.test.js`。

实际有效路径是 database 包 `dist/commonjs/index.js` 绑定的 `dist/commonjs/transaction/index.js`，不是另一个旧 `transaction.js`。核验结果：

| 调用 | 官方实际形状 | 引擎处理 |
| --- | --- | --- |
| transaction.collection(...).doc(id).get() | 存在 `{data:document}`；不存在 `{data:null}` | documentData兼容对象/null及普通读取数组；code错误抛出 |
| doc.set(rawObject) | 原始对象，不能包含_id；merge:false/upsert:true；携带 transactionId | 确定性doc ID，在事务内写事实及PENDING |
| doc.update(rawPatch) | 原始patch，经真实UpdateSerializer编码为 `$set`；携带 transactionId | 同事务更新报名实际参加人 |
| db.runTransaction(callback) | 自动commit，直接返回callback返回值；DATABASE_TRANSACTION_CONFLICT最多额外重试3次 | writer直接使用返回值；错误触发回滚 |
| SDK error response | document方法可能返回 `{code,...}`，取决于requester配置 | 显式requireDatabaseSuccess失败关闭，不把错误当not-found/写成功 |

真实安装模块24个断言验证版本和依赖、读不到/单对象/普通数组、raw写入真实serializer、transactionId、callback返回、冲突重试、重复幂等、外班确定性报名、code错误与回滚。仅 SDK 的 outbound request transport 为合成实现；未替换 DocumentReference 或事务实现。该证据确认调用形状，不代表真实云端事务并发/可用性已验收。

公开来源：[SDK 3.18.3 发布元数据](https://registry.npmjs.org/@cloudbase%2fnode-sdk/3.18.3)、[database 1.4.3 发布元数据](https://registry.npmjs.org/@cloudbase%2fdatabase/1.4.3)、[官方事务说明](https://docs.cloudbase.net/database/transaction)、[官方CLI函数配置](https://docs.cloudbase.net/cli-v1/functions/configs)。文档混合示例时以锁定发布包的有效实现为核验对象。

安装文件 SHA256：

```text
database/dist/commonjs/document.js
4A08BB8F4CDF2A29800B6C94CFADA8878D73D21BA6DCD0A13F3A9FA6629D2B50
database/dist/commonjs/transaction/index.js
3CBC34B9B82FE136ED14A17F98019AED31DA50377565DCA29023D765F796B440
cloudfunc/package-lock.json
76C4AF5460FF5E9914FC792E5E39CAC075EF5844916362A12E5D273AB798F5B7
```

lock记录的官方archive integrity：SDK为 `sha512-qluLOIyPhK8AWmUeS1Qt/S4cV/07pv/L79Cne8beFove775FL9Wi2tSsawZuwGUygIUySljqQaLPUl+lrJ4Leg==`，database为 `sha512-JzmdsGjy9LwzSQQ0Fv4OlNHNK61BRXdJSembTpy4408AQA3q2Ip3N5eB3v9OpAlFMvP/6MGmOQ/ZuUPKfJddJA==`。临时下载源、npm工具及验证日志仅在忽略的.codex-tmp，不能纳入发布包。
