# talk-plugin-prom

This plugin provides a [Prometheus](https://prometheus.io/) exporter for [Talk](https://github.com/coralproject/talk) by ways of a [plugin](https://docs.coralproject.net/talk/plugins/).

## Installation

Modify/create your plugins.json file to include the plugin:

```
{
  "server": [
    // ...
    {"@coralproject/talk-plugin-prom": "^1.0.0"},
    // ...
  ],
  "client": [
    // ...
  ]
}
```

Which will enable it.

## License

Talk is released under the Apache License, v2.0.