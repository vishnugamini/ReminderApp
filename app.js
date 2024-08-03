require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const flash = require('connect-flash');
const session = require('express-session');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false,  
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// Middleware
app.use(express.static(__dirname + '/public'));
app.set("view engine", "ejs");
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// Define Schemas and Models
const userSchema = new mongoose.Schema({
    username: String,
    password: String,
    email: { type: String, required: true, unique: true },
    isEmailVerified: { type: Boolean, default: false },
    emailVerificationToken: String,
    googleId: String,
    provider: { type: String, default: 'local' }
});

const todoSchema = new mongoose.Schema({
    name: String,
    dueDate: String,
    dueTime: String,
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
});

const reviewSchema = new mongoose.Schema({
    username: String,
    review: String
});

const Review = mongoose.model("Review", reviewSchema);
const User = mongoose.model("User", userSchema);
const Todo = mongoose.model("Todo", todoSchema);

// Configure Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Cron Job for Task Reminders
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60000);

    const dueTasks = await Todo.find({
        dueDate: tenMinutesFromNow.toISOString().split('T')[0],
        dueTime: {
            $gte: now.toISOString().split('T')[1].slice(0, 5),
            $lt: tenMinutesFromNow.toISOString().split('T')[1].slice(0, 5)
        }
    }).populate('user');

    dueTasks.forEach(task => {
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: task.user.email,
            subject: 'Task Reminder',
            text: `Reminder: Your task "${task.name}" is due at ${task.dueTime}.`
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error('Error sending email:', error);
            } else {
                console.log('Email sent:', info.response);
            }
        });
    });
});

// Passport Configuration
passport.use(new LocalStrategy(
    function(username, password, done) {
        User.findOne({ username: username }, function(err, user) {
            if (err) { return done(err); }
            if (!user) { return done(null, false, { message: 'Incorrect username.' }); }
            if (user.password !== password) { return done(null, false, { message: 'Incorrect password.' }); }
            return done(null, user);
        });
    }
));

passport.serializeUser(function(user, done) {
    done(null, user.id);
});

passport.deserializeUser(function(id, done) {
    User.findById(id, function(err, user) {
        done(err, user);
    });
});

// Routes
app.get("/", isAuthenticated, (req, res) => {
    Todo.find({ user: req.user._id }, (error, todoList) => {
        if (error) {
            console.error(error);
            res.status(500).send('Error fetching todo items');
        } else {
            res.render("index.ejs", { todoList: todoList });
        }
    });
});

app.get('/verify-email', async (req, res) => {
    const { token } = req.query;

    try {
        const user = await User.findOne({ emailVerificationToken: token });

        if (!user) {
            res.status(400).send('Invalid token');
        } else {
            user.isEmailVerified = true;
            user.emailVerificationToken = null;
            await user.save();
            res.send('Email verified successfully');
        }
    } catch (error) {
        console.error('Error verifying email:', error);
        res.status(500).send('Error verifying email');
    }
});

app.post('/newtodo', isAuthenticated, async (req, res) => {
    const { task, dueDate, dueTime } = req.body;
    const newTask = new Todo({
        name: task,
        dueDate: dueDate || null,
        dueTime: dueTime || null,
        user: req.user._id
    });
    await newTask.save();
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    req.logout(err => {
        if (err) {
            return next(err);
        }
        res.redirect('/');
    });
});

app.get("/delete/:id", isAuthenticated, (req, res) => {
    const taskId = req.params.id;
    Todo.deleteOne({ _id: taskId, user: req.user._id }, (err, result) => {
        if (err) {
            console.error(`Error in deleting the task ${taskId}`);
            res.status(500).send('Error deleting task');
        } else {
            console.log("Task successfully deleted from database");
            res.redirect("/");
        }
    });
});

app.post("/delAlltodo", isAuthenticated, (req, res) => {
    Todo.deleteMany({ user: req.user._id }, (err, result) => {
        if (err) {
            console.error(err);
            res.status(500).send('Error deleting all tasks');
        } else {
            console.log(`Deleted all tasks`);
            res.redirect("/");
        }
    });
});

app.post("/submit-review", isAuthenticated, (req, res) => {
    const { username, review } = req.body;
    const newReview = new Review({ username, review });
    newReview.save((err) => {
        if (err) {
            console.error('Error saving review:', err);
            res.status(500).send('Error saving review');
        } else {
            console.log('Review saved successfully');
            res.redirect('/review'); 
        }
    });
});

app.post("/updatetodo/:id", isAuthenticated, (req, res) => {
    const taskId = req.params.id;
    const newName = req.body.newName;

    Todo.findOneAndUpdate({ _id: taskId, user: req.user._id }, { name: newName }, (err, updatedTodo) => {
        if (err) {
            console.error(err);
            res.status(500).send('Error updating task');
        } else {
            console.log("Task successfully updated");
            res.redirect("/");
        }
    });
});

app.get('/login', (req, res) => {
    res.render('login', { message: req.flash('error') });
});

app.post('/login', passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login',
    failureFlash: true 
}));

app.get('/register', (req, res) => {
    res.render('register', {});
});

app.get("/review", isAuthenticated, (req, res) => {
    res.render("review.ejs", { username: req.user.username }); 
});

app.post('/register', (req, res) => {
    const { username, password, email } = req.body;

    User.findOne({ username: username }, (err, user) => {
        if (err) {
            console.error(err);
            res.status(500).send('Error checking for existing user');
        } else if (user) {
            req.flash('error', 'Username already exists');
            res.redirect('/register');
        } else {
            const newUser = new User({ username, password, email });
            newUser.save((err) => {
                if (err) {
                    console.error(err);
                    res.status(500).send('Error creating new user');
                } else {
                    req.flash('success', 'User registered successfully');
                    res.redirect('/login'); 
                }
            });
        }
    });
});

function isAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login');
}

app.get("*", (req, res) => {
    res.status(404).send("<h1>Invalid Page</h1>");
});

app.listen(port, (error) => {
    if (error) {
        console.error("Issue in connecting to the server:", error);
    } else {
        console.log("Successfully connected to the server");
    }
});
