const express = require('express');
const { router } = require('./routes/users');

express().use(router).listen(3000);
