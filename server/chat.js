"use strict";

module.exports = function(imports) {

    let express = imports.modules.express;
    let ObjectId = imports.modules.mongoose.Types.ObjectId;
    let Promise = imports.modules.Promise;
    let util = imports.util;

    let handler = util.handler;
    let requireLogin = util.requireLogin;
    let requireAdmin = util.requireAdmin;
    let checkBody = util.middlechecker.checkBody;
    let types = util.middlechecker.types;
    let audienceQuery = util.audience.audienceQuery;
    let isUserInAudience = util.audience.isUserInAudience;
    let sio = imports.sio;

    let Chat = imports.models.Chat;
    let User = imports.models.User;
    let Group = imports.models.Group;
    let Team = imports.models.Team;

    let router = express.Router();

    // TODO: separate this into separate requests for group and private chats
    router.post("/chats", checkBody(types.union([{
        isTwoPeople: types.value(true),
        otherUser: types.objectId(User),
    }, {
        isTwoPeople: types.value(false),
        audience: types.audience,
        name: types.string,
    }])), requireLogin, handler(function*(req, res) {

        if (req.body.isTwoPeople) {

            let otherUser = yield User.findOne({
                _id: req.body.otherUser,
            });
            if (!otherUser) {
                return res.status(400).end("That user does not exist");
            }

            // check to see if already exists
            if ((yield Chat.count({
                    isTwoPeople: true,
                    "audience.users": [req.body.otherUser, req.user._id],
                })) > 0) {
                return res.status(400).end("This chat already exists");
            }

            let chat = yield Chat.create({
                audience: {
                    groups: [],
                    users: [req.body.otherUser, req.user._id],
                },
                isTwoPeople: true,
            });

            chat.audience.users = [req.user, otherUser];

            yield util.populateTeams(chat);
            yield sio.createChat(chat);
            res.json(chat);

        } else {
            // group chat
            yield util.audience.ensureIncludes(req.body.audience, req.user);

            if (req.body.name.length >= 20) { // name character limit
                return res.status(400).end("The chat name has to be 19 characters or fewer");
                // TODO: get rid of this...
            }

            let chat = yield Chat.create({
                name: req.body.name,
                creator: req.user._id,
                audience: req.body.audience,
                isTwoPeople: false,
            });

            chat = yield Chat.populate(chat, "audience.users audience.groups");

            yield sio.createChat(chat);
            res.json(chat);
        }

    }));

    router.get("/chats", checkBody(), requireLogin, handler(function*(req, res) {

        // find a chat that has said user as a member
        let chats = yield Chat.find(audienceQuery(req.user), {
            _id: 1,
            name: 1,
            audience: 1,
            isTwoPeople: 1,
            updated_at: 1,
            messages: 1,
            creator: 1,
            unreadMessages: 1,
        })
            .slice("messages", [0, 1])
            .sort("-updated_at")
            .populate("messages.author audience.users audience.groups")
            .exec();
            // ^ the code above gets the latest message from the chat (for previews in iOS and Android) and orders the list by most recent.
        for (let chat of chats) {
            yield util.populateTeams(chat);
            yield chat.updateUnread();
        }

        res.json(chats);

    }));

    router.get("/chats/id/:chatId/messages", checkBody({
        skip: types.string,
    }), requireLogin, handler(function*(req, res) {

        let skip = parseInt(req.query.skip);

        // loads 20 messages after skip many messages. example: if skip is 0, it loads messages 0-19, if it"s 20, loads 20-39, etc.
        let chat = yield Chat.findOne({
            $and: [
                { _id: req.params.chatId },
                audienceQuery(req.user),
            ],
        })
            .select("+messages")
            .slice("messages", [skip, 20])
            .populate("messages.author")
            .exec();

        res.json(chat.messages);

    }));

    router.get("/chats/id/:chatId/users", checkBody(), requireLogin, handler(function*(req, res) {
        // user members only, not groups

        let chat = yield Chat.findOne({
            $and: [
                { _id: req.params.chatId },
                audienceQuery(req.user),
            ],
        }, {
            audience: 1,
        });

        let users = yield User.find({
            _id: {
                $in: chat.audience.members
            }
        });

        res.json(users);

    }));

    router.post("/chats/id/:chatId/audience/add", checkBody({
        audience: types.audience,
    }), requireLogin, handler(function*(req, res) {

        let chat = yield Chat.findOne({
            _id: req.params.chatId
        });

        if (req.user._id.toString() != chat.creator.toString()
            && !util.positions.isUserAdmin(req.user)
        ) {
            return res.status(403).end("You do not have permission");
        }

        yield Chat.update({
            _id: req.params.chatId,
        }, {
            $addToSet: {
                "audience.users": { $each: req.body.audience.users },
                "audience.groups": { $each: req.body.audience.groups },
            }
        });

        res.end();

    }));

    router.post("/chats/id/:chatId/audience/remove", checkBody({
        audience: types.audience,
    }), requireLogin, handler(function*(req, res) {

        let chat = yield Chat.findOne({
            _id: req.params.chatId
        });

        if (req.user._id.toString() != chat.creator.toString()
            && !util.positions.isUserAdmin(req.user)
        ) {
            return res.status(403).end("You do not have permission");
        }

        if ((chat.audience.groups.length + chat.audience.users.length)
            - (req.body.audience.groups.length + req.body.audience.users.length) < 1
        ) {
            return res.status(403).end("You cannot delete all the members of a group chat");
        }

        yield Chat.update({
            _id: req.params.chatId,
        }, {
            $pull: {
                "audience.users": { $in: req.body.audience.users },
                "audience.groups": { $in: req.body.audience.groups },
            }
        });

        res.end();

    }));


    router.get("/chats/id/:chatId/allMembers", checkBody(), requireLogin, handler(function*(req, res) {

        let chat = yield Chat.findOne({
            $and: [
                { _id: req.params.chatId },
                audienceQuery(req.user),
            ],
        }, {
            audience: 1,
            isTwoPeople: 1,
        });

        let userMembers = yield User.find({
            _id: {
                $in: chat.audience.users
            }
        });

        let groups = yield Group.find({
            _id: {
                $in: chat.audience.groups
            }
        })

        // TODO: the purpose of this currently is to show users and subdivisions
        // try clicking on the gear for a chat in morteam
        // should populate the individual users and groups of a chat
        // this will all be figured out once information is necessary on the frontend

        res.json({
            members: {
                userMembers: userMembers,
                groups: groups,
            },
            isTwoPeople: chat.isTwoPeople,
        });

    }));

    router.put("/chats/group/id/:chatId/name", checkBody({
        newName: types.string,
    }), requireLogin, handler(function*(req, res) {

        if (req.body.newName.length >= 20) {
            return res.status(400).end("Chat name has to be 19 characters or fewer");
        }

        let chat = yield Chat.findOne({
            $and: [
                { _id: req.params.chatId },
                audienceQuery(req.user),
            ],
        });

        if (!chat) {
            return res.status(404).end("This chat does not exist");
        }

        chat.name = req.body.newName;

        yield chat.save();

        yield sio.renameChat(chat);
        res.end();

    }));

    router.delete("/chats/id/:chatId", checkBody(), requireLogin, handler(function*(req, res) {

        let chat = yield Chat.findOne({
            _id: req.params.chatId,
        });

        if (!chat) {
            return res.status(404).end("This chat does not exist");
        }

        if (!isUserInAudience(req.user, chat.audience)
            && !(chat.isTwoPeople
            || util.positions.isUserAdmin(req.user)
            || req.user._id.toString() === chat.creator.toString())
        ) {
            return res.status(403).end("You do not have permission");
        }

        yield chat.remove();
        yield sio.deleteChat(chat);
        res.end();

    }));

    return router;

};
