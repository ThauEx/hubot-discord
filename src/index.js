/*
 * decaffeinate suggestions:
 * DS001: Remove Babel/TypeScript constructor workaround
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS103: Rewrite code to no longer use __guard__
 * DS205: Consider reworking code to avoid use of IIFEs
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
// Description:
//   Adapter for Hubot to communicate on Discord
//
// Commands:
//   None
//
// Configuration:
//   HUBOT_DISCORD_TOKEN          - authentication token for bot
//   HUBOT_DISCORD_STATUS_MSG     - Status message to set for "currently playing game"
//
// Notes:
//

const Adapter = require.main.require('hubot/src/adapter');
const Response = require.main.require('hubot/src/response');
const Robot = require.main.require('hubot/src/robot');
const User = require.main.require('hubot/src/user');
const {TextMessage, EnterMessage, LeaveMessage} = require.main.require('hubot/src/message');
const Discord = require('discord.js');
const {TextChannel} = Discord;
const ReactionMessage = require('./ReactionMessage');

//Settings
const currentlyPlaying = process.env.HUBOT_DISCORD_STATUS_MSG || '';

/** Extend default response with react method */
class DiscordResponse extends Response {
  react() {
    const strings = [].slice.call(arguments);

    return this.runWithMiddleware.apply(this, ['react', {plaintext: true}].concat(strings));
  }
}

/** Extend default Robot with react method */
Robot.prototype.react = function(matcher, options, callback) {
  // this function taken from the hubot-slack api
  let matchReaction = msg => msg instanceof ReactionMessage;

  if (arguments.length === 1) {
    return this.listen(matchReaction, matcher);

  } else if (matcher instanceof Function) {
    matchReaction = msg => msg instanceof ReactionMessage && matcher(msg);

  } else {
    callback = options;
    options = matcher;
  }

  return this.listen(matchReaction, options, callback);
};


class DiscordBot extends Adapter {
  constructor(robot) {
      super(...arguments);

      this._hasPermission = this._hasPermission.bind(this);
      this._sendSuccessCallback = this._sendSuccessCallback.bind(this);
      this._sendFailCallback = this._sendFailCallback.bind(this);
      this._getChannel = this._getChannel.bind(this);
      this.ready = this.ready.bind(this);
      this.enter = this.enter.bind(this);
      this.leave = this.leave.bind(this);
      this.message = this.message.bind(this);
      this.messageReaction = this.messageReaction.bind(this);
      this.disconnected = this.disconnected.bind(this);

      this.rooms = {};
      if ((process.env.HUBOT_DISCORD_TOKEN == null)) {
        this.robot.logger.error(`Error: Environment variable named \`HUBOT_DISCORD_TOKEN\` required`);
        return;
      }

      this.robot.Response = DiscordResponse;
    }

    run() {
      this.options = {token: process.env.HUBOT_DISCORD_TOKEN};

      this.client = new Discord.Client({
        autoReconnect: true,
        fetch_all_members: true,
        api_request_method: 'burst',
        ws: {compress: true, large_threshold: 1000}
      });
      this.robot.client = this.client;
      this.client.on('ready', this.ready);
      this.client.on('message', this.message);
      this.client.on('guildMemberAdd', this.enter);
      this.client.on('guildMemberRemove', this.leave);
      this.client.on('disconnected', this.disconnected);
      this.client.on('error', error => {
        return this.robot.logger.error(`The client encountered an error: ${error}`);
      });
      this.client.on('messageReactionAdd', (message, user) => {
        return this.messageReaction('reaction_added', message, user);
      });
      this.client.on('messageReactionRemove', (message, user) => {
        return this.messageReaction('reaction_removed', message, user);
      });

      return this.client.login(this.options.token).catch(this.robot.logger.error);
    }

    _mapUser(discord_user, channel_id) {
      const user = this.robot.brain.userForId(discord_user.id);
      user.room = channel_id;
      user.name = discord_user.username;
      user.discriminator = discord_user.discriminator;
      user.id = discord_user.id;

      return user;
    }

    _formatIncomingMessage(message) {
      if (this.rooms[message.channel.id] == null) {
        this.rooms[message.channel.id] = message.channel;
      }
      let text = message.cleanContent != null ? message.cleanContent : message.content;
      if ((message ? message.channel : undefined) instanceof Discord.DMChannel) {
        if (!text.match(new RegExp(`^@?${this.robot.name}`))) {
          text = `${this.robot.name}: ${text}`;
        }
      }

      return text;
    }

    _hasPermission(channel, user) {
      const isText = (channel !== null) && (channel.type === 'text');
      const permissions = isText && channel.permissionsFor(user);
      if (isText) {
        return ((permissions !== null) && permissions.hasPermission("SEND_MESSAGES"));
      } else {
        return channel.type !== 'text';
      }
    }

    _sendSuccessCallback(adapter, channel, message) {
      return adapter.robot.logger.debug(`SUCCESS! Message sent to: ${channel.id}`);
    }

    _sendFailCallback(adapter, channel, message, error) {
      adapter.robot.logger.debug(`ERROR! Message not sent: ${message}\r\n${err}`);
      // check owner flag and prevent loops
      if (process.env.HUBOT_OWNER && (channel.id !== process.env.HUBOT_OWNER)) {
        return sendMessage(process.env.HUBOT_OWNER, `Couldn't send message to ${channel.name} (${channel}) in ${channel.guild.name}, contact ${channel.guild.owner} to check permissions`);
      }
    }

    _getChannel(channelId) {
      let channel;
      if (this.rooms[channelId] != null) {
        channel = this.rooms[channelId];
      } else {
        const channels = this.client.channels.filter(channel => channel.id === channelId);
        if (channels.first() != null) {
          channel = channels.first();
        } else {
          channel = this.client.users.get(channelId);
        }
      }
      return channel;
    }

    ready() {
      this.robot.logger.info(`Logged in: ${this.client.user.username}#${this.client.user.discriminator}`);
      this.robot.name = this.client.user.username;
      this.robot.logger.info(`Robot Name: ${this.robot.name}`);
      this.emit("connected");

      //post-connect actions
      for (let channel of Array.from(this.client.channels)) {
        this.rooms[channel.id] = channel;
      }
      return this.client.user.setActivity(currentlyPlaying)
        .then(this.robot.logger.debug(`Status set to ${currentlyPlaying}`))
        .catch(this.robot.logger.error);
    }

    enter(member) {
      const user = member;
      this.robot.logger.debug(`${user} Joined`);
      return this.receive(new EnterMessage(user));
    }

    leave(member) {
      const user = member;
      this.robot.logger.debug(`${user} Left`);
      return this.receive(new LeaveMessage(user));
    }

    message(message) {
      // ignore messages from myself
      if (message.author.id === this.client.user.id) {
        return;
      }

      const user = this._mapUser(message.author, message.channel.id);
      const text = this._formatIncomingMessage(message);

      this.robot.logger.debug(text);

      return this.receive(new TextMessage(user, text, message.id));
    }

    messageReaction(reaction_type, message, user) {
      // ignore reactions from myself
      if (user.id === this.client.user.id) {
        return;
      }

      const reactor = this._mapUser(user, message.message.channel.id);
      const author = this._mapUser(message.message.author, message.message.channel.id);
      const text = this._formatIncomingMessage(message.message);

      const text_message = new TextMessage(reactor, text, message.message.id);
      let reaction = message._emoji.name;
      if (message._emoji.id != null) {
        reaction += `:${message._emoji.id}`;
      }

      return this.receive(new ReactionMessage(reaction_type, reactor, reaction, author,
        text_message, message.createdTimestamp)
      );
    }

    disconnected() {
      return this.robot.logger.info(`${this.robot.name} Disconnected, will auto reconnect soon...`);
    }

    send(envelope, ...messages) {
      return Array.from(messages).map((message) => this.sendMessage(envelope.room, message));
    }

    reply(envelope, ...messages) {
      return Array.from(messages).map((message) => this.sendMessage(envelope.room, `<@${envelope.user.id}> ${message}`));
    }

    sendMessage(channelId, message) {
      // Padded blank space before messages to comply with https://github.com/meew0/discord-bot-best-practices
      const zSWC = "\u200B";
      message = zSWC + message;

      const channel = this._getChannel(channelId);
      const that = this;

      // check permissions
      if (channel && (!(channel instanceof TextChannel) || this._hasPermission(channel, __guard__(this.robot != null ? this.robot.client : undefined, x => x.user)))) {
        return channel.send(message, {split: true})
          .then(msg => that._sendSuccessCallback(that, channel, message, msg)).catch(error => that._sendFailCallback(that, channel, message, error));
      }
      return this._sendFailCallback(this, channel, message, "Invalid Channel");
    }

    react(envelope, ...reactions) {
      const channel = this._getChannel(envelope.room);
      const that = this;

      const messageId = envelope.message instanceof ReactionMessage
        ? envelope.message.item.id
        : envelope.message.id;

      if (channel && (!(channel instanceof TextChannel) || this._hasPermission(channel, __guard__(this.robot != null ? this.robot.client : undefined, x => x.user)))) {
        return (() => {
          const result = [];
          for (var reaction of Array.from(reactions)) {
            this.robot.logger.info(reaction);
            result.push(channel.fetchMessage(messageId)
              .then(message => message.react(reaction)
                .then(msg => that._sendSuccessCallback(that, channel, message, msg)).catch(error => that._sendFailCallback(that, channel, message, error))).catch(error => that._sendFailCallback(that, channel, reaction, error)));
          }

          return result;
        })();
      }

      return this._sendFailCallback(this, channel, message, "Invalid Channel");
    }

    channelDelete(channel, client) {
      const roomId = channel.id;
      const user = new User(client.user.id);
      user.room = roomId;
      user.name = client.user.username;
      user.discriminator = client.user.discriminator;
      user.id = client.user.id;
      this.robot.logger.info(`${user.name}#${user.discriminator} leaving ${roomId} after a channel delete`);

      return this.receive(new LeaveMessage(user, null, null));
    }

    guildDelete(guild, client) {
      const serverId = guild.id;
      const roomIds = (Array.from(guild.channels).map((channel) => channel.id));

      return (() => {
        const result = [];
        for (let room in rooms) {
          const user = new User(client.user.id);
          user.room = room.id;
          user.name = client.user.username;
          user.discriminator = client.user.discriminator;
          user.id = client.user.id;
          this.robot.logger.info(`${user.name}#${user.discriminator} leaving ${roomId} after a guild delete`);
          result.push(this.receive(new LeaveMessage(user, null, null)));
        }

        return result;
      })();
    }
  }


exports.use = robot => new DiscordBot(robot);

function __guard__ (value, transform) {
  return (typeof value !== 'undefined' && value !== null) ? transform(value) : undefined
}
