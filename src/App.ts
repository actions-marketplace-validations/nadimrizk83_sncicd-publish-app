import * as core from '@actions/core'
import axios, { AxiosResponse } from 'axios'
import fs from 'fs'
import path from 'path'

import {
    RequestResult,
    AppProps,
    AppVersionResponse,
    axiosConfig,
    Errors,
    requestOptions,
    RequestResponse,
    ResponseStatus,
    ScopedVersion,
    User,
    VersionFormats,
    versionType,
    ErrorResult,
    Params,
} from './App.types'

export default class App {
    sleepTime = 3000
    user: User
    config: axiosConfig
    props: AppProps
    errCodeMessages: Record<number, string> = {
        401: 'The user credentials are incorrect.',
        403: 'Forbidden. The user is not an admin or does not have the CICD role.',
        404: 'Not found. The requested item was not found.',
        405: 'Invalid method. The functionality is disabled.',
        409: 'Conflict. The requested item is not unique.',
        500: 'Internal server error. An unexpected error occurred while processing the request.',
    }

    constructor(props: AppProps) {
        this.props = props
        this.user = {
            username: props.username,
            password: props.password,
        }
        this.config = {
            headers: {
                'User-Agent': 'sncicd_extint_github',
                Accept: 'application/json',
            },
            auth: this.user,
        }
    }

    buildParams(options: requestOptions): string {
        return (
            Object.keys(options)
                .filter(key => {
                    // @ts-ignore
                    return options.hasOwnProperty(key) && options[key]
                })
                // @ts-ignore
                .map(key => `${key}=${encodeURIComponent(options[key])}`)
                .join('&')
        )
    }
    /**
     * Takes options object, convert it to encoded URI string
     * and append to the request url
     *
     * @param options   Set of options to be appended as params
     *
     * @returns string  Url to API
     */
    buildRequestUrl(options: requestOptions): string {
        if (!this.props.nowSourceInstance || (!options.sys_id && !options.scope))
            throw new Error(Errors.INCORRECT_CONFIG)

        const params: string = this.buildParams(options)
        return `https://${this.props.nowSourceInstance}.servicenowservices.com/api/sn_cicd/app_repo/publish?${params}`
    }

    /**
     * Checks version
     * Increment version
     * Makes the request to ServiceNow api publish_app
     * Prints the progress
     * @returns         Promise void
     */
    async publishApp(): Promise<void> {
        try {
            const version = await this.increaseVersion()
            const devNotes = core.getInput('devNotes')
            const params: Params = {}

            if (this.props.appSysID) {
                params.sys_id = this.props.appSysID
            } else {
                params.scope = this.props.scope
            }

            const options: requestOptions = {
                ...params,
                version,
            }

            if (devNotes) options.dev_notes = devNotes

            const url: string = this.buildRequestUrl(options)
            const response: RequestResponse = await axios.post(url, {}, this.config)
            await this.printStatus(response.data.result)
        } catch (error) {
            let message: string
            if (error.response && error.response.status) {
                if (this.errCodeMessages[error.response.status]) {
                    message = this.errCodeMessages[error.response.status]
                } else {
                    const result: ErrorResult = error.response.data.result
                    message = result.error || result.status_message
                }
            } else {
                message = error.message
            }
            throw new Error(message)
        }
    }

    /**
     * Some kind of throttling, it used to limit the number of requests
     * in the recursion
     *
     * @param ms    Number of milliseconds to wait
     *
     * @returns     Promise void
     */
    sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            setTimeout(resolve, ms)
        })
    }

    /**
     * Print the result of the task.
     * Execution will continue.
     * Task will be working until it get the response with successful or failed or canceled status.
     *
     * @param result    TaskResult enum of Succeeded, SucceededWithIssues, Failed, Cancelled or Skipped.
     *
     * @returns         void
     */
    async printStatus(result: RequestResult): Promise<void> {
        if (+result.status === ResponseStatus.Pending) core.info(result.status_label)

        if (+result.status === ResponseStatus.Running || +result.status === ResponseStatus.Successful)
            core.info(`${result.status_label}: ${result.percent_complete}%`)

        // Recursion to check the status of the request
        if (+result.status < ResponseStatus.Successful) {
            const response: RequestResponse = await axios.get(result.links.progress.url, this.config)
            // Throttling
            await this.sleep(this.sleepTime)
            // Call itself if the request in the running or pending state
            await this.printStatus(response.data.result)
        } else {
            // Log the success result, the step of the pipeline is success as well
            if (+result.status === ResponseStatus.Successful) {
                core.info(result.status_message)
                core.info(result.status_detail)
            }

            // Log the failed result, the step throw an error to fail the step
            if (+result.status === ResponseStatus.Failed) {
                throw new Error(result.error || result.status_message)
            }

            // Log the canceled result, the step throw an error to fail the step
            if (+result.status === ResponseStatus.Canceled) {
                throw new Error(Errors.CANCELLED)
            }
        }
    }

    /**
     * Convert string to array of numbers like [x.x.x]
     *
     * @version Version to split
     *
     * @returns [x,x,x]
     */
    convertVersionToArr(version: string): number[] {
        return version.split('.').map(v => +v)
    }

    /**
     * Increment the version of the app.
     * It depends on which versionFormat is chosen
     * versionFormat can be set in the workflow file
     * and read in the action.yml file from the input variable
     */
    async increaseVersion(): Promise<string> {
        let version: versionType | false
        const v: string = (await this.getCurrentAppVersionTableApi(this.props.appSysID)) || ''
        switch (this.props.versionFormat) {
            case VersionFormats.Exact: {
                const input: string | undefined = core.getInput('version')
                if (!input) throw new Error(Errors.MISSING_VERSION)
                this.saveVersions(v, input)
                return input
            }
            case VersionFormats.Template: {
                const template: string | undefined = core.getInput('versionTemplate')

                if (!template) throw new Error(Errors.MISSING_VERSION_TEMPLATE)

                const newVersion: string = [template, '.', this.props.githubRunNum].join('')

                this.saveVersions(v, newVersion)
                return newVersion
            }
            case VersionFormats.Detect: {
                if (!this.props.appSysID && !this.props.scope) throw new Error(Errors.DETECT_SYS_ID_SCOPE)
                version = this.getCurrentAppVersionFromRepo()
                break
            }
            case VersionFormats.AutoDetect: {
                version = v !== 'none' ? v : false
                break
            }
            default: {
                throw new Error(Errors.INCORRECT_VERSION_FORMAT)
            }
        }

        if (version) {
            const rollBack = version
            // log the current version
            core.info('Current version is ' + version)
            // convert the version we got to [x.x.x]
            const versionsArr = version.split('.').map(digit => +digit)
            const incrementBy: number = +core.getInput('incrementBy') || 0
            if (incrementBy < 0) {
                throw new Error(Errors.NEGATIVE_INCREMENT)
            }
            // increment
            versionsArr[versionsArr.length - 1] += incrementBy
            // convert back to string x.x.x
            version = versionsArr.join('.')
            this.saveVersions(rollBack, version)
        } else {
            throw new Error('Version not found')
        }

        return version
    }

    saveVersions(current: string, incremented: string): void {
        core.setOutput('rollbackVersion', current)
        core.setOutput('newVersion', incremented)
    }

    /**
     * Recursion function
     *
     * @param urls string[]             List of API URLs to get versions(sys_app,sys_app_customization tables)
     * @returns Promise<string | false> Version or false if not found
     */
    async getVersionWithDefinedSysId(urls: string[]): Promise<string | false> {
        const url = urls.pop()

        // @ts-ignore
        return (
            axios
                // @ts-ignore
                .get(url, this.config)
                .then((response: AppVersionResponse) => {
                    return response.data.result.version || false
                })
                .catch(() => {
                    return false
                })
        )
    }

    /**
     *
     * @param url string                sys_app table url(sys_app_customization doesn't has scope field in response,
     *                                  so there is no sense to look for a version in this table if sys_id is undef)
     * @returns Promise<string | false> Version or false if not found
     */
    async getVersionWithUndefinedSysId(url: string): Promise<string | false> {
        return axios
            .get(url, this.config)
            .then((response: AxiosResponse) => {
                const result: ScopedVersion[] = response.data.result
                const found = result.find(e => {
                    return e.scope === this.props.scope
                })

                return found ? found.version : false
            })
            .catch(e => {
                throw new Error(this.errCodeMessages[e.response.status])
            })
    }

    /**
     * get current app version via now/table rest api
     *
     * @param appSysID
     *
     * @returns {Promise<string|boolean>}
     */
    async getCurrentAppVersionTableApi(appSysID: string): Promise<string | false> {
        const appSysIdParam = appSysID ? '/' + appSysID : ''
        const sysAppUrl = `https://${this.props.nowSourceInstance}.servicenowservices.com/api/now/table/sys_app${appSysIdParam}?sysparm_fields=version,scope`
        const sysAppCustomizationUrl = `https://${this.props.nowSourceInstance}.servicenowservices.com/api/now/table/sys_app_customization${appSysIdParam}?sysparm_fields=version`
        const urls = [sysAppUrl, sysAppCustomizationUrl]

        if (appSysID) {
            return await this.getVersionWithDefinedSysId(urls)
        } else {
            return this.getVersionWithUndefinedSysId(sysAppUrl)
        }
    }

    /**
     * Get the version of the app from the current repository.
     * It takes the sus_app_{app_sys_id}_.xml file
     * and parse for version attribute
     */
    getCurrentAppVersionFromRepo(): string | never {
        if (this.props.workspace) {
            const projectPath = [this.props.workspace, this.props.appSysID].join('/')
            console.log('Looking in ' + projectPath)

            const match = fs
                .readFileSync(path.join(projectPath, 'sys_app_' + this.props.appSysID + '.xml'))
                .toString()
                .match(/<version>([^<]+)<\/version>/)

            if (match) {
                return match[1]
            } else {
                throw new Error('Application version not found\n')
            }
        } else {
            throw new Error('GITHUB_WORKSPACE env not found\n')
        }
    }
}
