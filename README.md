Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select the `extension` directory.

Build:

```powershell
.\build.ps1
```

Run the tests and benchmark with Deno:

```powershell
deno test --allow-read .\tests
deno run --allow-read .\benchmark.js
```