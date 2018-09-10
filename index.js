const os = require('os');
const ms = require('ms');
const { URL } = require('url');
const onFinished = require('on-finished');
const client = require('prom-client');
const debug = require('debug')('talk-plugin-prom');

// Load the global Talk configuration, we want to grab some variables..
const { ROOT_URL } = require('config');

const config = require('./config');

// Label requests that have already been instrumented.
const IS_INSTRUMENTED = Symbol('IS_INSTRUMENTED');

if (
  process.env.NODE_ENV !== 'test' &&
  !config.PUSH_GATEWAY_URL &&
  !config.METRICS_MOUNT_PATH
) {
  throw new Error(
    'must specify at least one of PROM_METRICS_MOUNT_PATH PROM_PUSH_GATEWAY_URL'
  );
}

function configurePushgateway() {
  // Configure the pushgateway.
  const gateway = new client.Pushgateway(config.PUSH_GATEWAY_URL, {
    headers: { TTL: '10' },
  });

  // Parse the ROOT_URL because we want the hostname.
  const rootURL = new URL(ROOT_URL);

  // Configure pushing to the gateway at a predefined interval.
  setInterval(() => {
    gateway.push(
      {
        jobName: config.PUSH_JOB_NAME,
        groupings: {
          instance: os.hostname(),
          installation_domain: rootURL.hostname,
        },
      },
      (err, res, body) => {
        if (err) {
          console.error('error pushing to gateway', err);
        } else {
          debug(`pushed metrics ${JSON.stringify(body, null, 2)}`);
        }
      }
    );
  }, ms(config.PUSH_FREQUENCY));

  debug('push gateway configured');
}

if (process.env.NODE_ENV !== 'test' && config.PUSH_GATEWAY_URL) {
  configurePushgateway();
}

const connectedWebsocketsTotalGauge = new client.Gauge({
  name: 'talk_connected_websockets_total',
  help: 'number of websocket connections currently being handled',
});

// Reset the gauge to zero.
connectedWebsocketsTotalGauge.set(0);

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests made.',
  labelNames: ['code', 'method'],
});

const httpRequestDurationMilliseconds = new client.Histogram({
  name: 'http_request_duration_milliseconds',
  help: 'Histogram of latencies for HTTP requests.',
  buckets: [0.1, 5, 15, 50, 100, 500],
  labelNames: ['method', 'handler'],
});

const executedGraphQueriesTotalCounter = new client.Counter({
  name: 'talk_executed_graph_queries_total',
  help: 'number of GraphQL queries executed',
  labelNames: ['operation_type', 'operation_name'],
});

const graphQLExecutionTimingsHistogram = new client.Histogram({
  name: 'talk_executed_graph_queries_timings',
  help: 'timings for execution times of GraphQL operations',
  buckets: [0.1, 5, 15, 50, 100, 500],
  labelNames: ['operation_type', 'operation_name'],
});

// Configure the prom client to send default metrics.
client.collectDefaultMetrics({ prefix: 'talk_' });

module.exports = {
  websockets: {
    onConnect: () => {
      connectedWebsocketsTotalGauge.inc();
    },
    onDisconnect: () => {
      connectedWebsocketsTotalGauge.dec();
    },
  },

  // This is wrapped per request made against the graph.
  schemaLevelResolveFunction: (root, args, ctx, info) => {
    // NOTE: The following contains the query variables that you can use to
    //       further segment your metrics:
    //
    //       info.variableValues
    //
    //       Example: { assetId: '',
    //                  assetUrl: 'http://127.0.0.1:3000/',
    //                  commentId: '',
    //                  hasComment: false,
    //                  excludeIgnored: true,
    //                  sortBy: 'CREATED_AT',
    //                  sortOrder: 'DESC' }
    //

    // The GraphQL Operation Name. Example: CoralEmbedStream_Embed
    const name =
      info.operation.name !== null ? info.operation.name.value : null;
    const operation = info.operation.operation;

    // Attach the GraphQL Operation Name to the parent context, in this case,
    // the request object.
    ctx.parent.parent.graphql = {
      name,
      operation,
    };

    // You must _always_ return the root.
    return root;
  },

  app: app => {
    app.use('/', (req, res, next) => {
      req.now = Date.now();

      onFinished(res, () => {
        // Increment the request counter.
        httpRequestsTotal.labels(res.statusCode, req.method).inc();

        // Add the request duration.
        httpRequestDurationMilliseconds
          .labels(req.method, req.baseUrl + req.path)
          .observe(Date.now() - req.now);
      });

      // Continue the request flow.
      next();
    });

    if (config.METRICS_MOUNT_PATH) {
      app.get(config.METRICS_MOUNT_PATH, (req, res) => {
        res.set('Content-Type', client.register.contentType);
        res.end(client.register.metrics());
      });
    }

    app.use('/api/v1/graph/ql', (req, res, next) => {
      // Record the start time of the request.
      const start = Date.now();

      // Record that we're listening on the request.
      req._isInstrumented = IS_INSTRUMENTED;

      onFinished(res, () => {
        // Record the end time of the request.
        const duration = Date.now() - start;

        // Extract the graph details that we added to the parent context from
        // the request object.
        const { name, operation } = req.graphql;

        // Increment the graph query value, tagging with the name of the query.
        executedGraphQueriesTotalCounter.labels(operation, name).inc();

        graphQLExecutionTimingsHistogram
          .labels(operation, name)
          .observe(duration);
      });

      next();
    });
  },
};
