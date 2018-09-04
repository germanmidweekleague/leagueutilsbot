#!/bin/bash

pid=$(pidof node)
kill -9 $pid

nohup node bot.js &