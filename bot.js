const Discord = require('discord.js');//discord command set
const auth = require('./auth.json');//discord token
const sctoken = require('./scapitoken.json');//supercell api authorization
var config = require('./config.json');//static bot configuration
var devs = require('./devs.json');//bot devs list
const fs = require('fs');//filesystem command set
const readline = require('readline');//console read tool
const {google} = require('googleapis');//google api
const coc = require('clash-of-clans-api');
var client = coc({
  token: sctoken.token // Optional, can also use COC_API_TOKEN env variable
});

//create bot instance
const bot = new Discord.Client();

//(globally) declare schedule objects
var sched_leaguechecks = {};
var sched_banlist_updates = {};


//-------------set functions--------------

//------------- Google Sheets API ------------

//if modifying these scopes, delete credentials.json.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const TOKEN_PATH = 'credentials.json';

//generate OAuth2 with the given credentials to then authorize the given callback function
function authorize(credentials, callback, args) {
	const {client_secret, client_id, redirect_uris} = credentials.installed;
	const oAuth2Client = new google.auth.OAuth2(
	client_id, client_secret, redirect_uris[0]);
	// Check if we have previously stored a token.
	fs.readFile(TOKEN_PATH, (err, token) => {
		if (err) return getNewToken(oAuth2Client, callback);
		oAuth2Client.setCredentials(JSON.parse(token));
		callback(oAuth2Client, args);
	});
}
//get and store new token after promting the user, then execute the authorized callback
function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return callback(err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}
//makes a call to the google sheets API - programmer interface function
function callSheetsAPI(callback, args){
	// Load client secrets from a local file.
	fs.readFile('gs_client_secret.json', (err, content) => {
		if (err) return console.log('Error loading client secret file:', err);
		//authorize a call to the sheets api with callback and args to the callback function
		authorize(JSON.parse(content),callback,args);
	});
}

//------------------ Custom functions -----------------

//checks wether the user issueing a protected command has sufficient permissions. Returns a bool indicating that fact
function checkPerms(message, serverID, print){
	//print "Insufficient permissions" by default
	if(print === undefined) print = true;
	//check for bot-admin roles in user roles
	if(!message.member.roles.some(r=>config[serverID].botadmins.includes(r.name))){
		if(!message.member.permissions.has('ADMINISTRATOR')){
			if(print) message.channel.send("Insufficient permissions.");
			return false;
		}
	}
	return true;
}
//saves the locally changed configuration to the static config.json file
function saveConfig(){
	var json = JSON.stringify(config, null, "\t");
	fs.writeFile('config.json', json, error=>{if(error){console.log(error);}});
}
//modifies a coc player tag to meet the format internally required. Returns the modified player tag
function formatTag(playerID){
	//check for and remove leading '#' in player tag, then transform to uppercase
	if(playerID.substring(0,1)=='#'){
		playerID = playerID.substring(1);
	}
	playerID = playerID.toUpperCase();
	return playerID;
}

//make a call to the sc api to retrieve information about a player. Returns said information as a json string
//args = [sheetID, rawPlayerID, ranges, sheetName, row, message]
function callSCAPIandWriteToSheet(auth, args){
	var playerID = formatTag(args.rawPlayerID);
	var writeRange = args.ranges.map(function(input){return args.sheetName + '!' + input + args.row.toString()});
	var result = client.playerByTag('#' + playerID)
	.then(response => {
		if(response.clan === undefined){
			response.clan = {};
			response.clan.name = 'Not in any clan';
		}
		var data = [response.name, response.clan.name, response.clan.tag, new Date(args.message.createdTimestamp).toLocaleString()];
		var gobj = {
			"valueInputOption": "RAW",
			"data":[]
		};
		for (var i = 0; i < data.length; i++){
			gobj.data[i] = 
			{
				"range": writeRange[i],
				"majorDimension": "ROWS",
				"values": [
					[data[i]]
				]
			};
		}
		
		const sheets = google.sheets({version: 'v4', auth});
		sheets.spreadsheets.values.batchUpdate({
			"spreadsheetId": args.sheetID,
			"resource": gobj
		});
	})
	.catch(err => console.log(err));
}
//updates all player tags in range
//args = [sheetID, playerTagRange, identifier, message]
function bulkUpdate(auth, args){
	const sheets = google.sheets({version:'v4',auth});
	sheets.spreadsheets.values.get({
		"spreadsheetId": args.sheetID,
		"range": args.playerTagRange
	},(err,result)=>{
		var tags = result.data.values;
		var serverID = args.message.guild.id.toString();
		var ranges = [config[serverID].banlists[args.identifier].playerNameRange, config[serverID].banlists[args.identifier].playerClanRange, 
			config[serverID].banlists[args.identifier].clanTagRange, config[serverID].banlists[args.identifier].lastUpdateRange];
		ranges = ranges.map(function(input){return input.split('!')[1].charAt(0);});
		var sheetName = config[serverID].banlists[args.identifier].playerNameRange.split('!')[0];
		var row = config[serverID].banlists[args.identifier].playerNameRange.split('!')[1].split(':')[0].substring(1);
		args = {
			"sheetID": args.sheetID,
			"rawPlayerID": '',
			"ranges": ranges,
			"sheetName": sheetName,
			"row": row,
			"message": args.message
		};
		for (tag in tags){
			args.rawPlayerID = tags[tag][0];
			callSCAPIandWriteToSheet(auth,args);
			args.row++
		}
	});
}
//updates the last player tag
//args = [sheetID, identifier, message, tag]
function insertAtEnd(auth, args){	
	var serverID = args.message.guild.id.toString();
	var ranges = [config[serverID].banlists[args.identifier].playerNameRange, config[serverID].banlists[args.identifier].playerClanRange, 
		config[serverID].banlists[args.identifier].clanTagRange, config[serverID].banlists[args.identifier].lastUpdateRange];
	ranges = ranges.map(function(input){return input.split('!')[1].charAt(0);});
	var sheetName = config[serverID].banlists[args.identifier].playerNameRange.split('!')[0];
	args.tag = formatTag(args.tag);
	
	const sheets = google.sheets({version:'v4',auth});
	sheets.spreadsheets.values.append({
		"spreadsheetId":args.sheetID,
		"range":config[serverID].banlists[args.identifier].playerTagRange,
		"valueInputOption":"RAW",
		"insertDataOption":"INSERT_ROWS",
		"resource": {
			"values":[
				['#' + args.tag]
			]
		}
	},(err,result)=>{
		var row =result.data.updates.updatedRange.split('!')[1].substring(1);
		
		args = {
			"rawPlayerID": args.tag,
			"sheetID": args.sheetID,
			"message": args.message,
			"ranges": ranges,
			"sheetName": sheetName,
			"row": row
		};
		callSCAPIandWriteToSheet(auth,args);
	});//.catch(err){console.log(err)};
	args.message.channel.send('Player tag ' + '#' + args.tag + ' and associated data successfully added to the ban list "' + args.identifier + '".');
}
//cross-checks clan and ban list
//args = [bansheetID, clansheetID, channel, identifier, playerTagRange, playerClanTagRange, playerNameRange, clanTagRange, clanNameRange]
function crossCheck(auth, args){
	const sheets = google.sheets({version:'v4',auth});
	sheets.spreadsheets.values.batchGet({
		"spreadsheetId": args.bansheetID,
		"ranges": [args.playerTagRange, args.playerClanTagRange, args.playerNameRange]
	}, (err, result)=>{
		var incidents = 0;
		var playerTags = result.data.valueRanges[0].values;
		var playerClanTags = result.data.valueRanges[1].values;
		var playerNames = result.data.valueRanges[2].values;
		sheets.spreadsheets.values.batchGet({
			"spreadsheetId": args.clansheetID,
			"ranges": [args.clanTagRange, args.clanNameRange]
		},(err, result)=>{
			var leagueClans = result.data.valueRanges[0].values;
			var leagueNames = result.data.valueRanges[1].values;
			for(clan in playerClanTags){
				for(leagueclan in leagueClans){
					if(playerClanTags[clan].toString().replace('O','0') == leagueClans[leagueclan].toString().replace('O','0')){
						incidents++;
						args.channel.send(':warning: Banned Account **' + playerNames[clan] + ' ' + playerTags[clan] + '** in league clan **' 
						+ leagueNames[leagueclan] + ' ' + leagueClans[leagueclan] +'**!');
					}
				}
			}
			args.channel.send('League cross-check for "' + args.identifier + '" terminated with ' + incidents + ' incidents. Check the log for further details.');
		});
	});
}
//searches for a tag in a specified list and returns the index, if found or null. Then executes a callback function
//args = [sheetID, playerTagRange, tag, callbackFt, auth, callbackArgs]
function searchForTagAndCallback(auth, args){
	const sheets = google.sheets({version:'v4', auth});
	sheets.spreadsheets.values.get({
		"spreadsheetId": args.sheetID,
		"range": args.playerTagRange
	},(err,result)=>{
		args.tag = '#' + formatTag(args.tag);
		var tags = result.data.values;
		var ind = -1;
		for(tag in tags){
			if(tags[tag] == args.tag){
				ind = tag;
				break;
			}
		}
		args.callbackArgs.deleteIndex = parseInt(ind) + parseInt(config[args.callbackArgs.message.guild.id.toString()].banlists[args.callbackArgs.identifier].playerTagRange.split('!')[1].split(':')[0].substring(1));
		callbackFts[args.callbackFt](auth, args.callbackArgs);
	});
}
var callbackFts = {
	//deletes the specified row from the specified sheet, WHERE SHEET IS THE SHEET, NOT THE SPREADSHEET
	//args = [sheetID, spreadsheetID, message, identifier, deleteIndex]
	deleteRow: function(auth, args){
		args 
		var requests = [
			{
				"deleteDimension": {
					"range":{
						"sheetId": args.sheetID,
						"dimension": "ROWS",
						"startIndex": args.deleteIndex -1 ,
						"endIndex": args.deleteIndex
					}
				}
			}
			];
			const batchUpdateRequests = {requests};
			const sheets = google.sheets({version:'v4', auth});
			sheets.spreadsheets.batchUpdate({
				"spreadsheetId": args.spreadsheetID,
				"resource": batchUpdateRequests
			});
			args.message.channel.send('The player associated with your request was successfully removed from the banlist "' + args.identifier + '".');
	},
	//writes a response to discord chat
	//args = [message, identifier, deleteIndex]
	writeToDiscord: function(auth, args){
		if (args.deleteIndex == -1){
			args.message.channel.send('The account associated with your query is not on the banlist "' + args.identifier + '".')
		} else{
			args.message.channel.send('The account associated with your query is banned in "' + args.identifier + '" (row ' + args.deleteIndex + ').');
		}
	}
}

function execCheck(args, serverID){
	var logchannel = bot.channels.get(config[serverID].logchannel);
	args = {
		"identifier": args[0],
		"channel": logchannel,
		"bansheetID": config[serverID].banlists[args[0]].url.match('/spreadsheets/d/([a-zA-Z0-9-_]+)')[1],
		"clansheetID": config[serverID].clanlists[args[0]].url.match('/spreadsheets/d/([a-zA-Z0-9-_]+)')[1],
		"playerTagRange": config[serverID].banlists[args[0]].playerTagRange,
		"playerClanTagRange": config[serverID].banlists[args[0]].clanTagRange,
		"playerNameRange": config[serverID].banlists[args[0]].playerNameRange,
		"clanTagRange": config[serverID].clanlists[args[0]].clanTagRange,
		"clanNameRange": config[serverID].clanlists[args[0]].clanNameRange
	};
	//check if all lists exist, exit with error message if not. If yes, proceed
	if(config[serverID].banlists[args.identifier] === undefined || config[serverID].clanlists[args.identifier] === undefined){
		logchannel.send('Ban list: ' + config[serverID].banlists[args.identifier] + ', clanlist: ' + config[serverID].clanlists[args.identifier])
		return logchannel.send('Make sure both banlist and clan list for the identifier "' + args.identifier + '" exist.');
	}
	logchannel.send('League cross-check for "' + args.identifier + '" started.');
	callSheetsAPI(crossCheck,args);
}

function execUpdate(args, serverID){
	var logchannel = bot.channels.get(config[serverID].logchannel);	
	args = {
		"identifier": args[0],
		"message": logchannel.fetchMessage(logchannel.last_message_id),
		"sheetID": config[serverID].banlists[args[0]].url.match('/spreadsheets/d/([a-zA-Z0-9-_]+)')[1],
		"playerTagRange": config[serverID].banlists[args[0]].playerTagRange
	};
	//check if banlist exists, exit with error if not. If yes, set schedule and update the config
	if(config[serverID].banlists[args.identifier] === undefined) return logchannel.send('No banlist found for identifier "' + args.identifier +
	'".');
	//[sheetID, playerTagRange, identifier, message]
	callSheetsAPI(bulkUpdate,args);
	
}

function alertAll(message){
	var serverIDs = [];
	var tmp;
	for (var key in config){
		tmp = key.toString();
		serverIDs.push(tmp);
	}
	for (i in serverIDs){
		serverID = serverIDs[i];
		if (config[serverID].logchannel.length < 2) continue;
		var logchannel = bot.channels.get(config[serverID].logchannel);
		logchannel.send(message);
	}
}

//a dictionary containing all commands accepted by the discord bot
var commands = {
	testapi: function(args, message){
		args[3] = message;
		callSheetsAPI(insertAtEnd,args);
	},
	//ping, business as usual
	// .ping
	ping: function(args, message){
		message.channel.send('Pong.');
	},
	//change the bot's prefix. Admin permission level
	// .setprefix .
	setprefix: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'setprefix <Prefix>`');
		
		args = {
			"prefix": args[0]
		};
		//change prefix, confirm in discord channel and push the change to the config.json file
		config[serverID].prefix = args.prefix;
		message.channel.send('Prefix set to "`' + config[serverID].prefix + '`".');
		saveConfig();
	},
	//set an identifier, a confidence level and the URL where the specified ban list will be maintained. Admin permission level
	// .setbanlist GML true https://www.link-to-gml-ban-list.com
	setbanlist: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 8) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'setbanlist <Identifier> <Public? (true/false)> <Range for Player Tags> <Range for Player Names> <Range for Player Clans>' +
		' <Range for Clan Tags> <Range for Update-Timestamp> <Link to banlist>`. Please refer to the help for more detailled explanations.');
		
		args = {
			"identifier": args[0],
			"public": args[1],
			"playerTagRange": args[2],
			"playerNameRange": args[3],
			"playerClanRange": args[4],
			"clanTagRange": args[5],
			"lastUpdateRange": args[6],
			"url": args[7]
		};
		//update config, confirm in discord channel and push the change to the config.json file
		config[serverID].banlists[args.identifier] = {};
		config[serverID].banlists[args.identifier].public = args.public;
		config[serverID].banlists[args.identifier].url = args.url;
		config[serverID].banlists[args.identifier].playerTagRange = args.playerTagRange;
		config[serverID].banlists[args.identifier].playerNameRange = args.playerNameRange;
		config[serverID].banlists[args.identifier].playerClanRange = args.playerClanRange;
		config[serverID].banlists[args.identifier].clanTagRange = args.clanTagRange;
		config[serverID].banlists[args.identifier].lastUpdateRange = args.lastUpdateRange;
		message.channel.send('Banlist "' + args.identifier + '" updated.');
		saveConfig();
	},
	//set an identifier, a confidence level and the URL where the specified clan list will be maintained. Admin permission level
	// .setclanlist GML https://www.link-to-gml-clan-list.com
	setclanlist: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 2) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'setclanlist <Identifier> <Link to clan list>`');
		
		args = {
			"identifier": args[0],
			"url": args[1]
		};
		//update config, confirm in discord channel and push the change to the config.json file
		config[serverID].clanlists[args.identifier] = {};
		config[serverID].clanlists[args.identifier].url = args.url;
		message.channel.send('Clan list "' + args.identifier + '" updated.');
		saveConfig();
	},
	//print a link to the specified ban list
	// .banlist GML
	banlist: function(args, message, serverID){
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'banlist <Identifier>`');
		
		args = {
			"identifier": args[0]
		};
		//catch inexistant list
		if(config[serverID].banlists[args.identifier] === undefined) return message.channel.send('Invalid identifier. Please check for spelling errors.');
		//catch insufficient perms for private lists
		if(config[serverID].banlists[args.identifier].public == "false" && !checkPerms(message, serverID, false)) return message.channel.send(
		'Ban list ' + args.identifier + ' is set to private. You do not have sufficient permissions to view it');
		//post in discord channel
		message.channel.send('The ban list "' + args.identifier + '" can be viewed here: ' + config[serverID].banlists[args.identifier].url);
	},
	//print a link to the specified clan list
	// .clanlist GML
	clanlist: function(args, message, serverID){
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'clanlist <Identifier>`');
		
		args = {
			"identifier": args[0]
		};
		//catch inexistant list
		if(config[serverID].clanlists[args.identifier] === undefined) return message.channel.send('Invalid identifier. Please check for spelling errors.');
		//post in discord channel
		message.channel.send('The clan list "' + args.identifier + '" can be viewed here: ' + config[serverID].clanlists[args.identifier].url);
	},
	//prints a list of all available banlists
	// .banlists
	banlists: function(args, message, serverID){
		//extract all lists from banlist element
		var tmp = [];
		for (var key in config[serverID].banlists){
			if (config[serverID].banlists.hasOwnProperty(key)){
				tmp.push(key);
			}
		}
		//compile all lists into one string
		var output = tmp.join(", ");
		//post in discord channel
		message.channel.send('The following ban lists are available: ' + output + '. Use `' + config[serverID].prefix + 'banlist <Identifier>` to view them.');
	},
	//deletes the specified ban list. Admin permission level
	// .deletebanlist GML
	deletebanlist: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'deletebanlist <Identifier>`');
		
		args = {
			"identifier": args[0]
		};
		//catch inexistant list
		if(config[serverID].banlists[args.identifier] === undefined) return message.channel.send('Invalid identifier. Please check for spelling errors.');
		//delete list and push changes to the config.json file
		delete config[serverID].banlists[args.identifier];
		saveConfig();
		//confirm in discord channel
		message.channel.send('Banlist "' + args.identifier + '" deleted.');
	},
	//deletes the specified clan list. Admin permission level
	// .deleteclanlist GML
	deleteclanlist: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'deleteclanlist <Identifier>`');
		
		args = {
			"identifier": args[0]
		};
		//catch inexistant list
		if(config[serverID].clanlists[args.identifier] === undefined) return message.channel.send('Invalid identifier. Please check for spelling errors.');
		//delete list and push changes to the config.json file
		delete config[serverID].clanlists[args.identifier];
		saveConfig();
		//confirm in discord channel
		message.channel.send('Clan list "' + args.identifier + '" deleted.');
	},
	//list all available commands
	// .commands
	commands: function(args, message, serverID){
		//extract all commands from the command dict
		var tmp = [];
		for (var key in commands){
			if (commands.hasOwnProperty(key)){
				tmp.push('`' + config[serverID].prefix + key + '`');
			}
		}
		//compile them into one string
		var output = tmp.join("\n");
		//post in doscord channel
		message.channel.send('The following commands are available:\n' + output);
	},
	//grants a role bot-admin permissions. Admin permission level
	// .setadmin Organisator
	setadmin: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'setadmin <Role Name>`');
		
		args = {
			"role": args[0]
		};
		//catch role already having bot-admin permissions
		if(config[serverID].botadmins.indexOf(args.role) != -1) return message.channel.send('Role already has bot-admin permissions');
		//update config, confirm in discord channel and push changes to the config.json file
		config[serverID].botadmins.push(args.role);
		message.channel.send('Granted role "' + args.role + '" bot-admin permissions.');
		saveConfig();
	},
	//remove a role from the list of bot-admin roles. Admin permission level
	// .removeadmin Organisator
	removeadmin: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'removeadmin <Role Name>`');
		
		args = {
			"role": args[0]
		};
		//update config, confirm in discord channel and push changes to the config.json file
		var index = config[serverID].botadmins.indexOf(args.role);
		//catch inexistant role
		if(index == -1) return message.channel.send('Invalid role name. Role is either misspelled or has no bot-admin permissions.');
		config[serverID].botadmins.splice(index, 1);
		message.channel.send('Bot-admin permissions removed from role "' + args.role + '".');
		saveConfig();
	},
	//displays help information on a provided command
	// .help banlist
	help: function(args, message, serverID){
		args = {
			"cmd": args[0]
		};
		//catch inexistant command
		if(helpDict[args.cmd] === undefined) return message.channel.send('Invalid command name. Please check for spelling mistakes or use `' + 
		config[serverID].prefix + 'commands` for a list of all available commands');
		//post to discord channel
		var output = helpDict[args.cmd](serverID);	
		message.channel.send(output);
	},
	//sets the schedule for a league cross-check. Both ban and clan list for the provided identifier must exist. Admin permission level
	// .scheduleleaguecheck GML
	scheduleleaguecheck: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'scheduleleaguecheck <Identifier>`');
		
		args = {
			"identifier": args[0]
		};
		//check if all lists exist, exit with error message if not. If yes, set schedule and update the config
		if(config[serverID].banlists[args.identifier] === undefined || config[serverID].clanlists[args.identifier] === undefined) 
			return message.channel.send('Make sure both banlist and clan list for the identifier "' + args.identifier + '" exist.');
		sched_leaguechecks[serverID.toString() + args.identifier] = setInterval(execCheck.bind(null, [args.identifier], serverID), config[serverID].leaguecheck_timer);
		config[serverID].leaguechecks.push(args.identifier);
		saveConfig();
		//post to discord channel
		message.channel.send('Automated league cross-check for "' + args.identifier + '" scheduled successfully.');
	},
	//sets the schedule for a banlist update on the specified banlist. Admin permission level
	// .schedulebanlistupdate GML
	schedulebanlistupdate: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'schedulebanlistupdate <Identifier>`');
		
		args = {
			"identifier": agrs[0]
		};
		
		sched_banlist_updates[serverID.toString() + args.identifier] = setInterval(execUpdate.bind(null, [args.identifier], serverID), config[serverID].banlist_update_timer);
	},
	//sets the timer for the automated banlist update. Admin permission level
	// .setbanlistupdatetimer 3600000
	setbanlistupdatetimer: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'setbanlistupdatetimer <Time (ms)>`');
		
		args = {
			"time": args[0]
		};
		//update the config, then push the changes to the config.json file
		config[serverID].banlist_update_timer = args.time;
		saveConfig();
		//post to discord channel
		message.channel.send('Timer for automated banlist updates from Supercell servers updated.');
	},
	//sets the timer for the automated league cross-check. Admin permission level
	// .setleaguechecktimer 3600000
	setleaguechecktimer: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'setleaguechecktimer <Time (ms)>`');
		
		args = {
			"time": args[0]
		};
		//update the config, then push the changes to the config.json file
		config[serverID].leaguecheck_timer = args.time;
		saveConfig();
		//post to discord channel
		message.channel.send('Timer for automated league cross-checks updated.');
	},
	//deletes the automated league cross-check. Admin permission level
	// .deleteleaguecheck GML
	deleteleaguecheck: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'deleteleaguecheck <Identifier>`');
		
		args = {
			"identifier": args[0]
		};
		//catch inexistant identifier
		if(sched_leaguechecks[serverID.toString() + args.identifier] === undefined) return message.channel.send('Invalid identifier. Please check for spelling mistakes.');
		clearInterval(sched_leaguechecks[serverID.toString() + args.identifier]);
		config[serverID].banlist_updates = config[serverID].banlist_updates.filter(x => x != args.identifier);
		message.channel.send('Automated leaguecheck for "' + args.identifier + '" successfully deleted');
	},
	//deletes the automated banlist update. Admin permission level
	// .deletebanlistupdate GML
	deletebanlistupdate: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'deletebanlistupdate <Identifier>`');
		
		args = {
			"identifier": args[0]
		};
		//catch inexistant identifier
		if(sched_banlist_updates[serverID.toString() + args.identifier] === undefined) return message.channel.send('Invalid identifier. Please check for spelling mistakes.');
		clearInterval(sched_banlist_updates[serverID.toString() + args.identifier]);
		config[serverID].banlist_updates = config[serverID].banlist_updates.filter(x => x != args.identifier);
		message.channel.send('Automated banlist update for banlist "' + args.identifier + '" successfully deleted');
	},
	//sets a channel for the bot to log banlist updates and league cross-check results. Admin permission level
	// .setlogchannel channelID
	setlogchannel: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch wrong parameter count
		if(args.length != 1) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'setlogchannel <Channel ID>`');
		
		args = {
			"channel": args[0]
		};
		config[serverID].logchannel = args.channel;
		message.channel.send('Logchannel updated.');
	},
	//add a player tag to the specified ban list, then perform an update on the newly added player tag. Admin permission level
	// .ban GML #PLAYERTAG
	ban: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;

		args = {
			"identifier": args[0],
			"tag": args[1],
			"message": message,
			"sheetID": config[serverID].banlists[args[0]].url.match('/spreadsheets/d/([a-zA-Z0-9-_]+)')[1]
		};
		callSheetsAPI(insertAtEnd,args);
	},
	//remove a player tag and all associated data from the specified ban list. Admin permission level
	// .unban GML #PLAYERTAG
	unban: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		
		args = {
			"identifier": args[0],
			"tag": args[1]
		};
		//catch inexistant list
		if(config[serverID].banlists[args.identifier] === undefined) return message.channel.send('Invalid banlist identifier. Please check for spelling errors.');
		
		args = {
			"tag": args.tag,
			"sheetID": config[serverID].banlists[args.identifier].url.match('/spreadsheets/d/([a-zA-Z0-9-_]+)')[1],
			"playerTagRange": config[serverID].banlists[args.identifier].playerTagRange,
			"callbackFt": 'deleteRow',
			"callbackArgs": {
				"sheetID": config[serverID].banlists[args.identifier].url.match('[#&]gid=([0-9]+)')[1],
				"spreadsheetID": config[serverID].banlists[args.identifier].url.match('/spreadsheets/d/([a-zA-Z0-9-_]+)')[1],
				"identifier": args.identifier,
				"message": message,
				"deleteIndex": ''
			}
		};
		callSheetsAPI(searchForTagAndCallback, args);
	},
	//perform an update on the entire specified ban list, fetching info for every player tag on the list. Admin permission level
	// .updatebanlist GML
	updatebanlist: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		
		args = {
			"identifier": args[0],
			"message": message,
			"sheetID": config[serverID].banlists[args[0]].url.match('/spreadsheets/d/([a-zA-Z0-9-_]+)')[1],
			"playerTagRange": config[serverID].banlists[args[0]].playerTagRange
		};
		callSheetsAPI(bulkUpdate,args);
	},
	//checks if the provided playertag is on the specified ban list
	// .amibanned GML #PLAYERTAG 
	amibanned: function(args, message, serverID){
		//catch wrong parameter count
		if(args.length != 2) return message.channel.send('Incorrect parameter count. Command must be `' + config[serverID].prefix +
		'amibanned <Identifier> <Player Tag>`');
		args = {
			"tag": args[1],
			"sheetID": config[serverID].banlists[args[0]].url.match('/spreadsheets/d/([a-zA-Z0-9-_]+)')[1],
			"playerTagRange": config[serverID].banlists[args[0]].playerTagRange,
			"callbackFt": 'writeToDiscord',
			"callbackArgs": {
				"message": message,
				"identifier": args[0],
				"deleteIndex": ''
			}
		}
		callSheetsAPI(searchForTagAndCallback, args);
	},
	//cross-checks the clan and ban lists for the provided league specifier. Admin permission level
	// .leaguecheck GML
	leaguecheck: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		if(!checkPerms(message, serverID)) return;
		//catch missing log channel
		if(config[serverID].logchannel === undefined) return logchannel.send('No log channel defined. Please use ' + config[serverID].prefix +
		'setlogchannel <Channel ID>` to specify one, then rerun the command.');	
		execCheck(args, serverID)
	},
	
	
	//restarts the bot. Bot devs only
	// .restart
	restart: function(args, message, serverID){
		//break if the user issueing the command does not have sufficient permissions
		var perms = false;
		for (i in devs.botdevs){
			if(message.member.user.id == devs.botdevs[i]){
				perms = true;
			}
		}
		if(!perms) return message.channel.send('Insufficient permissions.');
		alertAll('Bot is restarting and should be back shortly. Note that all running automated updates will be interrupted and have' +
		' to be restarted manually. We apologize for the inconvenience');
		//googeln ob/wie man aus js ein bash-Script aufrufen kann (kill.sh)
	}
}
//dictionary mapping command names to help messages
var helpDict = {
	ping: function(serverID){return 'Pings the bot. Bot will respond with "Pong!" if everything is fine. Usage: `' + config[serverID].prefix + 'ping`';},
	setprefix: function(serverID){return 'Set the prefix you want the bot to respond to. Bot-Admin permissions required. Usage: `' + config[serverID].prefix + 'setprefix <Prefix>`';},
	setbanlist: function(serverID){return 'Set the URL where a banlist will be maintained, the confidence level (a Boolean indicating wether the list should be public)' +  
	', a set of cell ranges and an identifier for said list. Bot-Admin permissions required. Usage: `' + config[serverID].prefix + 
	'setbanlist <Identifier> <Public? (true/false)> <Range for Player Tags> <Range for Player Names> <Range for Player Clans> <Range for Clan Tags>' +
	' <Range for Update-Timestamp> <Link to banlist>`. If the Player Tags are located on a sheet named "Bans" in column B from row 4 and below, the' +
	'corresponding range is "Bans!B4:B"';},
	setclanlist: function(serverID){return 'Set the URL where a clan list will be maintained and an identifier for said list. Bot-Admin permissions ' + 
	'required. Usage: `' + config[serverID].prefix + 'setclanlist <Identifier> <Link to the clan list>`';},
	banlist: function(serverID){return 'Print the link to the banlist specified by the provided identifier. Non-public banlists require Bot-Admin permissions to print. Usage: `' +
	config[serverID].prefix + 'banlist <Identifier>`';},
	clanlist: function(serverID){return 'Print the link to the clanlist specified by the provided identifier. Usage: `' + config[serverID].prefix + 'clanlist <Identifier>`';},
	banlists: function(serverID){return 'Print a list of all available banlists (public and private lists will show). Usage: `' + config[serverID].prefix + 'banlists`';},
	clanlists: function(serverID){return 'Print a list of all available clanlists. Usage: `' + config[serverID].prefix + 'clanlists`';},
	deletebanlist: function(serverID){return 'Delete all banlist data associated with the provided identifier. Bot-Admin permissions required. Usage: `' + config[serverID].prefix + 
	'deletebanlist <Identifier>`';},
	deleteclanlist: function(serverID){return 'Delete all clan list data associated with the provided identifier. Bot-Admin permissions required. Usage: `' + config[serverID].prefix + 
	'deleteclanlist <Identifier>`';},
	commands: function(serverID){return 'Prints a list of all available commands. Usage: `' + config[serverID].prefix + 'commands`';},
	setadmin: function(serverID){return 'Grant a role Bot-admin permissions, enabling users in that role to execute all protected commands. Users/roles with server admin permissions ' +
	'have Bot-admin permissions per dafault. Bot-Admin permissions required. ' + 'Usage: `' + config[serverID].prefix + 'setadmin <Role Name>`';},
	removeadmin: function(serverID){return 'Remove bot-admin permissions from a role, prohibiting users in that role to execute any protected command (unless they have ' + 
	'bot-admin status granted by another role). Bot-Admin permissions required. Usage: `' + config[serverID].prefix + 'removeadmin <Role Name>`';},
	help: function(serverID){return 'Displays a help message for the command associated with the request. Usage: `' + config[serverID].prefix + 'help (<Command Name>)`';},
	scheduleleaguecheck: function(serverID){return 'Schedules an automated league cross-check with the league-specific ban and clan lists. There can only be one active automated' +
	' league cross-check at a time. Bot-admin permissions required. ' + 'Usage: `' + config[serverID].prefix + 'scheduleleaguecheck <Identifier>`';},
	schedulebanlistupdate: function(serverID){return 'Schedules an automated banlist update from Supercell servers. There can only be one active automated update at a time.' +
	' Bot-Admin premissions required. Usage: `' + config[serverID].prefix + 'schedulebanlistupdate <Identifier>`';},
	deleteleaguecheck: function(serverID){return 'Deletes an automated league cross-check. Bot-admin permissions required. Usage: `' + config[serverID].prefix +
	'deleteleaguecheck <Identifier>`';},
	deletebanlistupdate: function(serverID){return 'Deletes an automated banlist update. Bot-admin permissions required. Usage: `' + config[serverID].prefix +
	'deletebanlistupdate <Identifier>`';},
	setleaguechecktimer: function(serverID){return 'Sets the timer for the automated league cross-check. Usage: `' + config[serverID].prefix + 'setleaguechecktimer <Time (ms)>`';},
	setbanlistupdatetimer: function(serverID){return 'Sets the timer for the automated banlist update from Supercell servers. Usage: `' + config[serverID].prefix +
	'setbanlistupdatetimer <Time (ms)>`';},
	ban: function(serverID){return 'Add a player tag to the specified banlist and perform an update on the newly added tag. Bot-admin permissions required. Usage: `' +
	config[serverID].prefix + 'ban <Identifier> <Player Tag>`';},
	unban: function(serverID){return 'Remove a player tag and all associated data from the specified banlist. Bot-Admin permissions required. Usage: `' + config[serverID].prefix +
	'unban <Identifier> <Player Tag>`';},
	updatebanlist: function(serverID){return 'Perform an update on the entire banlist, fetching data for every player tag from Supercell servers. Bot-Admin permissions required.' +
	' Usage: `' + config[serverID].prefix + 'updatebanlist <Identifier>`';},
	amibanned: function(serverID){return 'Checks, if the provided player tag is on the provided banlist. If no banlist identifier is given, checks all lists. Usage: `' + 
	config[serverID].prefix + 'amibanned <Player Tag> (<Identifier>)`';},
	leaguecheck: function(serverID){return 'Triggers a league cross-check for the provided league. Both ban and clan list for the given identifier must exist and a log channel' +
	' must be set. Bot-admin permissions required. Usage: `' + config[serverID].prefix + 'leaguecheck <Identifier>`';},
	restart: function(serverID){return 'Restarts the bot. Bot developers exclusively. Usage: `' + config[serverID].prefix + 'restart`';},
	setlogchannel: function(serverID){return 'Sets the channel where league cross-check and banlist updates will be logged. If no log channel is provided, the logs will be ' +
	'printed to the channel where the command was called. Bot-admin permissions required. Usage: `' +
	config[serverID].prefix + 'setlogchannel <Channel ID>`';},
}


//------------bot handles-------------

//bot init actions
bot.on('ready',() => {
	console.log('Connected');
    console.log('Logged in as: ');
    console.log(bot.username + ' - (' + bot.id + ')');
	//alertAll('Bot is online and ready');
	
	for (serverID in config){
		if (config[serverID].leaguechecks.length != 0){
			for (i in config[serverID].leaguechecks){
				identifier = config[serverID].leaguechecks[i];
				sched_leaguechecks[serverID.toString() + identifier] = setInterval(execCheck.bind(null, [identifier], serverID), config[serverID].leaguecheck_timer);			
			}
		}
		if (config[serverID].banlist_updates.length != 0){
			for (identifier in config[serverID].banlist_updates){
				sched_banlist_updates[serverID.toString() + identifier] = setInterval(execUpdate.bind(null, [identifier], serverID), config[serverID].banlist_update_timer);
			}
		}
	}
});

//bot is invited to a new server
bot.on('guildCreate', (guild) =>{
	//create new config entry with preset standard values
	var guildID = guild.id.toString();
	config[guildID] = {
		"prefix": ".",
		"banlists": {},
		"clanlists": {},
		"botadmins": [],
		"leaguecheck_timer": "21600000",
		"leaguechecks": [],
		"banlist_update_timer": "86400000",
		"banlist_updates": [],
		"logchannel": ""
	};
	saveConfig();
});

//bot is removed from a server
bot.on('guildDelete', (guild) =>{
	var guildID = guild.id.toString();
	delete config[guildID];
	saveConfig();
});

//bot message handler
bot.on('message', (message) =>{
	try{
		var serverID = message.guild.id.toString();
		//ignore bots and messages without prefix
		if(message.author.bot) return;
		if(message.content.indexOf(config[serverID].prefix) != 0) return;
		
		//get arguments and command
		var parsedArgs = message.content.slice(config[serverID].prefix.length).trim().split(/ +/g);
		var cmd = parsedArgs[0];
		var args = parsedArgs.splice(1);
		
		//catch inexistant command
		if(commands[cmd] === undefined) return message.channel.send('Unknown command. Please check for spelling errors or type `' + config[serverID].prefix + 
		'commands` for a list of available commands`');
		
		//execute command
		commands[cmd](args, message, serverID);
	} catch(error){
		console.log(error);
	}
});

//connect bot to discord
bot.login(auth.token);

//Just to test the workflow