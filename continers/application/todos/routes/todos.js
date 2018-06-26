var express = require('express');
var Promise = require('bluebird');
var mysql = require('mysql');
var router = express.Router();
var AWS = require('aws-sdk');
var multer = require('multer');
var upload = multer({ dest: '/tmp' });
var readChunk = require('read-chunk');
var fileType = require('file-type');
var crypto = require('crypto');
var redis = require('redis');
const url = require('url');
Promise.promisifyAll(redis.RedisClient.prototype);

var pool = Promise.promisifyAll(mysql.createPool({
  connectionLimit: 3,
  host           : process.env.MYSQL_HOST,
  port           : process.env.MYSQL_PORT,
  user           : process.env.MYSQL_USER,
  password       : process.env.MYSQL_PASS,
  database       : process.env.MYSQL_DB,
}));

var s3Config = {
  accessKeyId    : process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY,
  region         : process.env.AWS_REGION
}
const s3Bucket = process.env.AWS_S3_BUCKET;
const imageUrlEndpoint = process.env.IMAGE_ENDPOINT;

var redisClient = redis.createClient({
  host           : process.env.REDIS_HOST,
  port           : process.env.REDIS_PORT
});

// for emulation.
if (process.env.AWS_ENDPOINT) {
  var port = process.env.AWS_PORT;
  s3Config['endpoint'] = process.env.AWS_ENDPOINT + ':' + port;
  s3Config['s3ForcePathStyle'] = true;
  s3Config['signatureVersion'] = 'v4';
}

var s3 = Promise.promisifyAll(new AWS.S3(s3Config));

class InsertTodoError extends Error {
  constructor ( message, extra ) {
    super()
    Error.captureStackTrace( this, this.constructor )
    this.name = 'InsertTodoError'
    this.message = message
    if ( extra ) this.extra = extra
  }
}

class DeleteTodoNotFoundError extends Error {
  constructor ( message, extra ) {
    super()
    Error.captureStackTrace( this, this.constructor )
    this.name = 'DeleteTodoNotFoundError'
    this.message = message
    if ( extra ) this.extra = extra
  }
}

/* Create todo. */
router.get('/create', function(req, res, next) {
  res.render('todos/edit', { row: null });
});

/* Edit todo. */
router.get('/edit/:id', function(req, res, next) {
  const id = req.params.id;
  pool.queryAsync('SELECT * FROM todos WHERE id = ?', [id])
  .then(function(rows) {
    console.log("edit:" + rows);

    const row = rows[0];
    if (!row) return res.sendStatus(404);
    res.render('todos/edit', { row: row });
  })
  .catch(function(error) {
    return next(error);
  });
});

/* Create or edit todo. */
router.post('/edit', upload.single('image'), function(req, res, next) {
  console.log("file:" + JSON.stringify(req.file));
  const id = req.body.id;
  const title = req.body.title;

  if (id) {
    // edit
    const idNum = parseInt(id, 10)
    if (!(Number.isInteger(idNum) && idNum > 0)) return res.sendStatus(400);

    Promise.resolve()
    .then(function() {
      return pool.getConnectionAsync()
    })
    .then(function(connection) {
      var connectionAsync = Promise.promisifyAll(connection);
      connectionAsync.beginTransactionAsync()
      .then(function() {
        return handleUploadImage(req);
      })
      .then(function(data) {
        console.log("result of s3:" + JSON.stringify(data));
        var updateData = { title: title };
        if (data && data.Location) {
          const imageUrl = url.parse(data.Location);
          updateData['image_url'] = imageUrl.pathname;
        }
        return connectionAsync.queryAsync('UPDATE todos SET ? WHERE id = ?',[updateData, idNum])
      })
      .then(function(results) {
        if (results.affectedRows != 1) {
          console.log("nothing updated!");
          connection.rollback();
          return res.sendStatus(400);
        }

        connection.commit();
        redisClient.del(idNum);
        res.redirect('/todos/' + idNum);
      })
      .catch(function(error) {
        console.log("edit:" + error);
        connection.rollback();
        console.log("data rollbacked.");
        return next(error);
      })
      .finally(function() {
        connection.release();
        console.log("connection released");
      });
    })
    .catch(function(error) {
      console.log("error:" + error);
      return next(error);
    });
  } else {
    // create
    Promise.resolve()
    .then(function() {
      return handleUploadImage(req);
    })
    .then(function(data) {
      console.log("result of s3:" + JSON.stringify(data));
      pool.getConnectionAsync()
      .then(function(connection) {
        var connectionAsync = Promise.promisifyAll(connection);

        connectionAsync.beginTransactionAsync()
        .then(function() {
          var insertData = { title: title };
          if (data && data.Location) {
            const imageUrl = url.parse(data.Location);
            insertData['image_url'] = imageUrl.pathname;
          }
          return connectionAsync.queryAsync('INSERT INTO todos SET ?', insertData);
        })
        .then(function(results) {
          if (results.insertId) {
            connection.commit();
            redisClient.del(results.insertId);
            res.redirect('/todos/' + results.insertId);
          } else {
            throw new InsertTodoError("Insert record failed.");
          }
        })
        .catch(function(error) {
          console.log("error:" + error);
          connection.rollback();
          console.log("data rollbacked.");
          if (error instanceof InsertTodoError) {
            console.log("something wrong!");
            return res.sendStatus(500);
          } else {
            return next(error);
          }
        })
        .finally(function() {
          connection.release();
          console.log("connection released");
        });
      });
    })
    .catch(function(error) {
      console.log("aws upload error:" + error);
      next(error);
    });
  }
});

function handleUploadImage(req) {
  if (req.file) {
    const buffer = readChunk.sync(req.file.path, 0, req.file.size);
    const uploadFileType = fileType(buffer);
    console.log("type:" + JSON.stringify(uploadFileType));

    if (uploadFileType && uploadFileType.ext) {
      const fileName = (new Date()).getTime() + '-' + crypto.randomBytes(8).toString('hex') + '.' + uploadFileType.ext;
      console.log("fileName: " + fileName);
      return s3.uploadAsync({
        Bucket: s3Bucket,
        Key: fileName,
        Body: buffer,
        ACL: 'public-read'
      });
    }
  }
  return null
}

/* Delete todo. */
router.delete('/:id', function(req, res, next) {
  const id = req.params.id;
  pool.getConnectionAsync()
  .then(function(connection) {
    var connectionAsync = Promise.promisifyAll(connection);

    connectionAsync.beginTransactionAsync()
    .then(function() {
      return connectionAsync.queryAsync('DELETE FROM todos WHERE id = ?', [id])
    })
    .then(function(results) {
      if (results.affectedRows < 1) {
        throw new DeleteTodoNotFoundError("No target record found.");
      }
      connection.commit();
      res.json({message: 'success to delete'});
    })
    .catch(function(error) {
      console.log("delete:" + error);
      connection.rollback();
      console.log("data rollbacked.");
      if (error instanceof DeleteTodoNotFoundError) {
        return res.sendStatus(404);
      } else {
        return next(error);
      }
    })
    .finally(function() {
      console.log("connection released");
      connection.release();
    });
  });
});

/* Show single todo. */
router.get('/:id', function(req, res, next) {
  const id = req.params.id;

  redisClient.getAsync(id)
  .then(function(response) {
    console.log("get:" + JSON.stringify(response));
    if (response) {
      console.log("render from cache.");
      const row = JSON.parse(response);
      res.render('todos/show', { row: row, imageUrlEndpoint: imageUrlEndpoint });
    } else {
      pool.queryAsync('SELECT * FROM todos WHERE id = ?', [id])
      .then(function(rows) {
        const row = rows[0];
        if (!row) return res.sendStatus(404);

        redisClient.set(id, JSON.stringify(row));
        res.render('todos/show', { row: row, imageUrlEndpoint: imageUrlEndpoint });
      })
     .catch(function(error) {
       return next(error);
     });
    }
  })
  .catch(function(error) {
    console.log("redis error:" + error);
  });
});

/* Show all todo. */
router.get('/', function(req, res, next) {
  pool.queryAsync('SELECT * FROM todos')
  .then(function(rows) {
    res.render('todos/index', { rows: rows });
  })
  .catch(function(error) {
    console.log("show all:" + error);
    return next(error);
  });
});

module.exports = router;
