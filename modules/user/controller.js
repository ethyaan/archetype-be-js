import { createHash } from 'node:crypto'
import { ModelFactory, handleError, createErrorObject } from '../../common/index.js';
import { UserModel } from './schema.js';
import _ from 'lodash';
import { Auth, SendGrid, ReCaptcha } from '../../services/index.js';
import config from '../../config.js';

/**
 * Define Sample module
 * @type Class
 */
class userController {
    /**
     * constructor to Set routing NameSpace and registering the routes
     * @param app
     */
    constructor(app) {

        Object.assign(this, app);

        this.model = new ModelFactory(UserModel);
        this.errorHandler = handleError;
    }

    signup = async ({ body: { email, name, lastName, password, captcha } }, res) => {

        const userEmail = email.toLowerCase();
        const userName = name.toLowerCase();
        const userLastname = lastName.toLowerCase();
        const userPassword = this.sha256(password);

        try {

            if (process.env.NODE_ENV !== 'test') {
                await ReCaptcha.verifyRecaptcha(captcha);
            }

            const verificationCode = this.generateVerificationCode();
            const newUser = await this.model.createEntity({
                email: userEmail,
                name: userName,
                lastName: userLastname,
                verificationCode,
                password: userPassword
            });

            if (process.env.NODE_ENV !== 'test') {
                const templateTags = [
                    { name: "__USERNAME", value: newUser.email },
                    { name: "__CONFIRMATION_URL", value: verificationCode }, // Todo: #44 is here
                ];

                SendGrid.sendMailByTemplate(
                    'Welcome - Confirm your email address',
                    'signup',
                    templateTags,
                    [newUser.email],
                    'no-reply@site.com'
                );
            }

            res.send({ username: newUser.email, verificationCodeDate: newUser.verificationCodeDate });
        } catch (error) {
            const errorMessage = _.get(error, 'errorMessage', false);
            // if we get duplicate error message from mongoose, we handle different response
            if (errorMessage && errorMessage.includes('duplicate key error')) {
                const user = await this.model.findEntityByParams({ email: userEmail }, { verified: true });
                this.errorHandler(createErrorObject({ options: { msg: 'user Already Registered.' }, additionalInfo: { verified: user.verified } }), res);
            } else {
                this.errorHandler(error, res);
            }
        }
    }

    /**
     * resend verification code, in case user didn't received the code
     * @param {*} req 
     * @param {*} res 
     */
    resendVerification = async (req, res) => {
        try {
            const userEmail = req.body.email.toLowerCase();
            const userInfo = await this.model.findEntityByParams({ email: userEmail });
            if (_.get(userInfo, 'verified') || !userInfo) {
                return res.send({ status: 'failed' });
            } else {
                const vcDate = new Date(userInfo.verificationCodeDate);
                vcDate.setMinutes(vcDate.getMinutes() + config.VERIFICATION_CODE_LIFE_TIME);
                let verificationCodeDate = userInfo.verificationCodeDate;
                if (
                    (process.env.NODE_ENV !== 'test' && vcDate.getTime() < Date.now()) ||
                    process.env.NODE_ENV === 'test') {
                    const verificationCode = this.generateVerificationCode();
                    verificationCodeDate = new Date();
                    await this.model.updateEntityByModel(userInfo, {
                        verificationCode,
                        verificationCodeDate
                    });

                    if (process.env.NODE_ENV !== 'test') {
                        const key = this.sha256(verificationCode);
                        const verificationURL = `${config.APP_URL}/user/verify/${key}`;
                        const templateTags = [
                            { name: "__USERNAME", value: userInfo.email },
                            { name: "__CONFIRMATION_URL", value: verificationURL },
                        ];

                        SendGrid.sendMailByTemplate(
                            'Confirm your email address',
                            'signup-confirmation',
                            templateTags,
                            [newUser.email],
                            'no-reply@site.com'
                        );
                    }
                }
                res.send({ status: 'success', verificationCodeDate });
            }
        } catch (error) {
            this.errorHandler(error, res);
        }
    }

    /**
     * verify the email by code and generate verificationCode to set password
     * @param req
     * @param res
     */
    verify = async (req, res) => {
        try {
            let frontURL = `${config.APP_FRONT}/confirmation/`;
            const code = req.params.code;
            const userInfo = await this.model.findEntityByParams({ verificationCode: code });
            if (userInfo === null) {
                frontURL += `failed`;
                return res.redirect(frontURL);
            }
            const vcDate = new Date(userInfo.verificationCodeDate);
            vcDate.setMinutes(vcDate.getMinutes() + config.VERIFICATION_CODE_LIFE_TIME);
            if (vcDate.getTime() > Date.now()) {
                await this.model.updateEntityByModel(userInfo, { verified: true });
                frontURL += `success`;
            } else {
                frontURL += `failed`;
            }
            res.redirect(frontURL);
        } catch (error) {
            this.errorHandler(error, res);
        }
    }

    /**
     * express middleware authenticate user with credential
     * @param req
     * @param res
     * @param next
     */
    userAuth = async (req, res, next) => {
        try {
            const { body: { email, password } } = req;
            const userEmail = email.toLowerCase();
            const pwd = this.sha256(password);
            let userInfo = await this.model.findEntityByParams({ email: userEmail, password: pwd }, { 'password': false });
            if (userInfo === null) {
                return res.send({ status: 'failed', message: 'username or password is wrong!' });
            }
            const token = await Auth.sign(userInfo.toObject());
            res.set('Authorization', token);
            req._user = userInfo;
            next();
        } catch (error) {
            this.errorHandler(error, res);
        }
    }

    /**
     * login method to send the user detail
     * @param req
     * @param res
     */
    login = async ({ _user: { name = ``, lastName = ``, email = `` } = {} }, res) => {
        res.send({ name, lastName, email });
    }

    /**
     * change user password
     * @param req
     * @param res
     */
    changeUserPassword = async (req, res) => {
        try {
            const { _user, body: { password, new: newPWD } = {} } = {} = req;
            const userInfo = await this.model.findEntityByParams({ email: _user.email });
            if (!!userInfo && this.sha256(password) === userInfo.password) {
                await this.model.updateEntityByModel(userInfo, { password: this.sha256(newPWD) });
                res.send({ status: 'success' });
            } else {
                res.send({ status: 'failed', message: 'current password is wrong' });
            }
        } catch (error) {
            this.errorHandler(error, res);
        }
    }

    /**
     * update user profile
     * @param req
     * @param res
     */
    updateProfile = async (req, res) => {
        try {
            const { _user, body: { name, lastName } } = req;
            const userInfo = await this.model.findEntityByParams({ _id: _user._id });
            await this.model.updateEntityByModel(userInfo, { name, lastName });
            res.send({ status: 'success', message: 'your profile updated successfully' });
        } catch (error) {
            this.errorHandler(error, res);
        }
    }

    /**
     * generate a new random password and share with user
     * @param req
     * @param res
     */
    forgetPassword = async ({ body: { email } }, res) => {
        try {
            const userEmail = email.toLowerCase();
            const userInfo = await this.model.findEntityByParams({ email: userEmail }, { password: false });
            if (userInfo === null) {
                return res.send({ status: 'failed', message: 'user does not exists' });
            }
            const vcDate = new Date(userInfo.verificationCodeDate);
            vcDate.setMinutes(vcDate.getMinutes() + config.VERIFICATION_CODE_LIFE_TIME);
            if (Date.now() < vcDate.getTime()) {
                res.send({ status: 'success', verificationCodeDate: userInfo.verificationCodeDate });
            } else if (userInfo.verified === true) {
                const verificationCode = this.generateVerificationCode();
                const verificationCodeDate = new Date();
                await this.model.updateEntityByModel(userInfo, {
                    verificationCode,
                    verificationCodeDate
                });
                if (process.env.NODE_ENV !== 'test') {
                    const templateTags = [
                        { name: "__USERNAME", value: userInfo.email },
                        { name: "__RESET_URL", value: verificationCode },  // Todo: #44 is here
                    ];

                    SendGrid.sendMailByTemplate(
                        'Forgot your password?',
                        'forget-password',
                        templateTags,
                        [newUser.email],
                        'no-reply@site.com'
                    );
                }

                res.send({ success: 'success', verificationCodeDate });
            } else {
                res.send({ status: 'failed' });
            }
        } catch (error) {
            this.errorHandler(error, res);
        }
    }

    /**
     * set new password
     * @param req
     * @param res
     */
    setNewPassword = async ({ body: { email, code, password } }, res) => {
        try {
            const userEmail = email.toLowerCase();
            const userInfo = await this.model.findEntityByParams({ email: userEmail });
            if (userInfo === null) {
                return res.send({ status: 'failed', message: 'user does not exists' });
            }
            const secureKeyDate = new Date(userInfo.verificationCodeDate);
            secureKeyDate.setMinutes(secureKeyDate.getMinutes() + config.VERIFICATION_CODE_LIFE_TIME);
            if (userInfo.verificationCode === code && userInfo.verified === true && secureKeyDate.getTime() > Date.now()) {
                const newPassword = (password) ? this.sha256(password).toString() : '';
                await this.model.updateEntityByModel(userInfo, { password: newPassword });
                res.send({ status: 'success' });
            } else {
                res.send({ status: 'failed', message: 'invalid or expired request' });
            }
        } catch (error) {
            this.errorHandler(error, res);
        }
    }

    /**
     * get logged in user profile detail
     * @param req
     * @param res
     */
    getProfile = async ({ _user: { _id } }, res) => {
        try {
            const userProfile = await this.model.findEntityByParams({ _id }, {
                _id: 0, password: 0, verificationCode: 0, verificationCodeDate: 0, verified: 0
            });
            res.send({ status: 'success', data: userProfile });
        } catch (error) {
            this.errorHandler(error, res);
        }
    }

    /**
     * generate a 6 digit verification code
     */
    generateVerificationCode = () => {
        return Math.floor(100000 + Math.random() * 900000);
    }

    /**
     * create sha256 hex string
     * @param {*} content 
     * @returns 
     */
    sha256 = (content) => {
        return createHash('sha256').update(content).digest('hex');
    }

}

export default (app) => new userController(app);
