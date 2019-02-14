module.exports = function(RED) {
  "use strict";
  var fs = require("fs");
  var FTPS = require("ftps");
  var Parser = require("parse-listing");
  var tmp = require("tmp");
  var utils = require("./utils");

  function LftpConfigNode(n) {
    RED.nodes.createNode(this, n);

    this.options = {
      host: n.host || "localhost", // required
      protocol: n.protocol || "ftp", // Optional, values : 'ftp', 'sftp', 'ftps', ... default: 'ftp'
      // protocol is added on beginning of host, ex : sftp://domain.com in this case
      port: n.port || 21, // Optional
      // port is added to the end of the host, ex: sftp://domain.com:22 in this case
      escape: n.escape || true, // optional, used for escaping shell characters (space, $, etc.), default: true
      retries: n.retries || 2, // Optional, defaults to 1 (1 = no retries, 0 = unlimited retries)
      timeout: n.timeout || 10, // Optional, Time before failing a connection attempt. Defaults to 10
      retryInterval: n.retryInterval || 5, // Optional, Time in seconds between attempts. Defaults to 5
      retryMultiplier: n.retryMultiplier || 1, // Optional, Multiplier by which retryInterval is multiplied each time new attempt fails. Defaults to 1
      requiresPassword: n.requiresPassword || false, // Optional, defaults to true
      autoConfirm: false, // Optional, is used to auto confirm ssl questions on sftp or fish protocols, defaults to false
      cwd: "", // Optional, defaults to the directory from where the script is executed
      additionalLftpCommands: n.additionalLftpCommands || "", // Additional commands to pass to lftp, splitted by ';'
      requireSSHKey: false, //  Optional, defaults to false, This option for SFTP Protocol with ssh key authentication
      sshKeyPath: "/path/id_dsa" // Required if requireSSHKey: true , defaults to empty string, This option for SFTP Protocol with ssh key authentication
    };

    this.options.username = "";
    this.options.password = "";
    if (this.credentials && this.credentials.hasOwnProperty("username")) {
      this.options.username = this.credentials.username;
    }
    if (this.credentials && this.credentials.hasOwnProperty("password")) {
      this.options.password = this.credentials.password;
    }
  }

  RED.nodes.registerType("lftp-config", LftpConfigNode, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" }
    }
  });

  function LftpCommandNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    this.server = n.server;
    this.operation = n.operation;
    this.filename = n.filename;
    this.localFilename = n.localFilename;
    this.workdir = n.workdir;
    this.savedir = n.savedir;
    this.serverConfig = RED.nodes.getNode(this.server);
    //this.credentials = RED.nodes.getCredentials(this.server);

    var statuses = {
      active: { fill: "blue", shape: "dot", text: "executing" },
      error: { fill: "red", shape: "dot", text: "error" },
      blank: {}
    };

    if (this.server) {
      //console.log("lftp - this.serverConfig: " + JSON.stringify(this.serverConfig));

      node.on("input", function(msg) {
        try {
          var event = {};
          event.workdir = node.workdir || msg.workdir || "";
          event.filename = node.filename || msg.payload.filename || "";
          event.targetFilename =
            node.targetFilename || msg.payload.targetFilename || "";
          event.savedir = node.savedir || msg.savedir || "";
          event.localFilename = node.localFilename || msg.localFilename || "";

          //console.log("lftp - performing operation: " + node.operation);

          node.status(statuses.active);

          /**
           * Returns true if the reponse is an error, false otherwise
           *
           * @param {*} err
           * @param {*} res
           */
          var responseErrorHandler = function(err, res) {
            var message = err || res.error;
            if (message) {
              node.error(message, msg);
              node.status(statuses.blank);
              return true;
            } else {
              return false;
            }
          };

          switch (node.operation) {
            case "list":
              var conn = new FTPS(node.serverConfig.options);
              conn
                .cd(event.workdir)
                .ls()
                .exec(function(err, res) {
                  //console.log(res);
                  if (!responseErrorHandler(err, res)) {
                    Parser.parseEntries(res.data, function(err, data) {
                      msg.workdir = event.workdir;
                      msg.payload = data;
                      node.send(msg);
                      node.status(statuses.blank);
                    });
                  }
                });
              break;
            case "get":
              // set filename
              var filename =
                utils.addTrailingSlash(event.workdir) + event.filename;

              var conn = new FTPS(node.serverConfig.options);
              conn.cat(filename).exec(function(err, res) {
                //console.log(res);
                if (!responseErrorHandler(err, res)) {
                  msg.workdir = event.workdir;
                  msg.payload = {};
                  msg.payload.filedata = res.data;
                  msg.payload.filename = event.filename;
                  msg.payload.filepath = filename;
                  node.send(msg);
                  node.status(statuses.blank);
                }
              });
              break;
            case "put":
              if (!event.filename.length > 0) {
                var d = new Date();
                var guid = d.getTime().toString();

                if (event.fileExtension == "") {
                  event.fileExtension = ".txt";
                }

                event.filename = guid + node.fileExtension;
              }

              var filename =
                utils.addTrailingSlash(event.workdir) + event.filename;
              var filedata =
                msg.payload.filedata || JSON.stringify(msg.payload);

              /**
               * with lftp we cannot stream data directly so it must be
               * temporarily written to disk, put, then deleted locally
               */
              tmp.file(function(err, path, fd, cleanupCallback) {
                if (err) throw err;

                fs.writeFile(path, filedata, function(err) {
                  if (err) {
                    cleanupCallback();
                    throw err;
                  }

                  var conn = new FTPS(node.serverConfig.options);
                  conn.put(path, filename).exec(function(err, res) {
                    //console.log(res);
                    cleanupCallback();
                    if (!responseErrorHandler(err, res)) {
                      msg.workdir = event.workdir;
                      msg.payload = {};
                      msg.payload.filename = event.filename;
                      msg.payload.filepath = filename;
                      node.send(msg);
                      node.status(statuses.blank);
                    }
                  });
                });
              });
              break;
            case "delete":
              // set filename
              var filename =
                utils.addTrailingSlash(event.workdir) + event.filename;

              var conn = new FTPS(node.serverConfig.options);
              conn.rm(filename).exec(function(err, res) {
                //console.log(res);
                if (!responseErrorHandler(err, res)) {
                  msg.workdir = event.workdir;
                  msg.payload = {};
                  msg.payload.filename = event.filename;
                  msg.payload.filepath = filename;
                  node.send(msg);
                  node.status(statuses.blank);
                }
              });
              break;
            case "move":
              // move filename
              var filename =
                utils.addTrailingSlash(event.workdir) + event.filename;
              var targetFilename =
                utils.addTrailingSlash(event.workdir) + event.targetFilename;

              var conn = new FTPS(node.serverConfig.options);
              conn.mv(filename, targetFilename).exec(function(err, res) {
                //console.log(res);
                if (!responseErrorHandler(err, res)) {
                  msg.workdir = event.workdir;
                  msg.payload = {};
                  msg.payload.filename = event.targetFilename;
                  msg.payload.filepath = targetFilename;
                  node.send(msg);
                  node.status(statuses.blank);
                }
              });
              break;
            case "raw":
              var conn = new FTPS(node.serverConfig.options);
              if (Array.isArray(msg.payload)) {
                for (var i = 0, len = msg.payload.length; i < len; i++) {
                  conn.raw(msg.payload[i]);
                }
              } else {
                conn.raw(msg.payload);
              }
              conn.exec(function(err, res) {
                //console.log(res);
                if (!responseErrorHandler(err, res)) {
                  msg.payload = res.data;
                  node.send(msg);
                  node.status(statuses.blank);
                }
              });
              break;
          }
        } catch (error) {
          node.error(error, msg);
          node.status(statuses.blank);
        }
      });
    } else {
      node.error("missing server configuration");
      node.status(statuses.blank);
    }
  }

  RED.nodes.registerType("lftp-command", LftpCommandNode);
};
