const os = require('os');
const cluster = require('cluster');
const ms = require('ms');
const { URL } = require('url');
const onFinished = require('on-finished');
const client = require('prom-client');
const debug = require('debug')('talk-plugin-prom');
const { get } = require('lodash');
const uuid = require('uuid/v1');

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

  // Grab the hostname that we'll use to key this instance.
  const instance =
    os.hostname() + cluster.worker ? `#worker.${cluster.worker.id}` : '';

  // Configure pushing to the gateway at a predefined interval.
  setInterval(() => {
    gateway.push(
      {
        jobName: config.PUSH_JOB_NAME,
        groupings: {
          instance,
          installation_domain: rootURL.hostname,
        },
      },
      err => {
        if (err) {
          console.error('error pushing to gateway', err);
        } else {
          debug(`pushed metrics`);
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

// Store all the connection ID's in this map, this way we can ensure we aren't
// duplicating the same metric over and over again.
const connections = new Map();

module.exports = {
  websockets: {
    onConnect: (connectionParams, connection) => {
      // Assign an ID to the connection if it doesn't have one already.
      let id = get(connection, 'upgradeReq.id');
      if (!id) {
        id = uuid();
        connection.upgradeReq.id = id;
      }

      // Increment the connected websocket connections if we haven't seen this
      // connection before.
      if (!connections.has(id)) {
        connections.set(id, Date.now());
        connectedWebsocketsTotalGauge.inc();
      }
    },
    onDisconnect: connection => {
      // Grab the ID, and decrement the gauge if we haven't seen this before.
      const id = get(connection, 'upgradeReq.id');
      if (id && connections.has(id)) {
        // TODO: record the websocket session length?
        connections.delete(id);
        connectedWebsocketsTotalGauge.dec();
      }
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
    const name = get(info, 'operation.name.value', null);
    const operation = get(info, 'operation.operation', null);

    // Attach the GraphQL Operation Name to the parent context, in this case,
    // the request object.
    ctx.rootParent.graphql = {
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
        const { name, operation } = get(req, 'graphql', {
          name: null,
          operation: null,
        });
        if (!name || !operation) {
          return;
        }

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
